#!/usr/bin/env node
/**
 * Generate image dimension manifest for kid photos.
 *
 * Fetches a tiny (1px wide) version of each unique image from Cloudflare Images
 * and records the original aspect ratio. CF Images preserves the original aspect
 * ratio when only width is specified, so a 1px fetch gives us the true w:h ratio
 * in a single ~50-byte response.
 *
 * Run: node scripts/generate-dimensions.js
 * Output: src/data/dimensions-kids.json  →  { "kids/alex/photo-01": [4, 3], ... }
 *
 * Values are stored as [w, h] at a normalized scale (GCD-reduced) to keep the
 * manifest tiny and let consumers build any size from the ratio.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { cfId, CF_BASE } from './cf-image-shared.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const KIDS_DIR = join(ROOT, 'src', 'content', 'kids');
const OUT_DIR = join(ROOT, 'src', 'data');
const OUT_FILE = join(OUT_DIR, 'dimensions-kids.json');

function gcd(a, b) {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

/**
 * Fetch a 1px-wide image from CF and read the actual pixel dimensions
 * from the response. CF returns the image at its natural aspect ratio
 * when only width is constrained.
 *
 * We use w=32 instead of w=1 because some CF image pipelines quantize
 * to minimum sizes. 32px is still tiny (~200 bytes) but reliable.
 */
async function fetchDimensions(imageId) {
  const url = `${CF_BASE}/${imageId}/w=32,q=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());

    // Try to extract dimensions from the image header directly
    // JPEG: look for SOF0/SOF2 marker
    // PNG: dimensions at fixed offset
    // WebP/AVIF: use content-type hint + binary parsing

    const ct = (res.headers.get('content-type') || '').toLowerCase();

    let w = 0, h = 0;

    if (ct.includes('png')) {
      // PNG: width at byte 16, height at byte 20 (big-endian uint32)
      if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
        w = buf.readUInt32BE(16);
        h = buf.readUInt32BE(20);
      }
    } else if (ct.includes('jpeg') || ct.includes('jpg')) {
      // JPEG: scan for any SOF marker (FFC0–FFC3, FFC5–FFC7, FFC9–FFCB, FFCD–FFCF)
      // CF Images often returns SOF1 (FFC1 = Extended Sequential DCT)
      for (let i = 0; i < buf.length - 9; i++) {
        if (buf[i] === 0xFF) {
          const m = buf[i + 1];
          if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
            h = buf.readUInt16BE(i + 5);
            w = buf.readUInt16BE(i + 7);
            if (w > 0 && h > 0) break;
          }
        }
      }
    } else if (ct.includes('webp')) {
      // WebP VP8: "RIFF....WEBP" header then VP8 chunk
      if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF') {
        const chunk = buf.toString('ascii', 12, 16);
        if (chunk === 'VP8 ') {
          // Lossy VP8: width/height at bytes 26-29 (little-endian, 14-bit each)
          w = buf.readUInt16LE(26) & 0x3FFF;
          h = buf.readUInt16LE(28) & 0x3FFF;
        } else if (chunk === 'VP8L') {
          // Lossless VP8L: 1 signature byte then 14+14 bits for w/h
          const bits = buf.readUInt32LE(21);
          w = (bits & 0x3FFF) + 1;
          h = ((bits >> 14) & 0x3FFF) + 1;
        }
      }
    }

    if (w > 0 && h > 0) {
      const d = gcd(w, h);
      return [w / d, h / d];
    }

    return null;
  } catch {
    return null;
  }
}

async function main() {
  if (!existsSync(KIDS_DIR)) {
    console.error('No kids content directory found. Run prebuild first.');
    process.exit(1);
  }

  // Load existing manifest to avoid re-fetching
  let existing = {};
  if (existsSync(OUT_FILE)) {
    try {
      existing = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    } catch { /* start fresh */ }
  }

  const files = readdirSync(KIDS_DIR).filter(f => f.endsWith('.json'));

  // Collect all unique image IDs across hero, photos, and storyPhotos
  const imageIds = new Set();
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(KIDS_DIR, file), 'utf8'));
      if (data.heroImage) imageIds.add(cfId(data.heroImage));
      for (const p of data.photos || []) {
        if (p.url) imageIds.add(cfId(p.url));
      }
      for (const p of data.storyPhotos || []) {
        if (p.url) imageIds.add(cfId(p.url));
      }
    } catch { /* skip malformed */ }
  }

  const allIds = [...imageIds].filter(Boolean);
  console.log(`Dimensions: ${allIds.length} unique images across ${files.length} kids...\n`);

  const manifest = {};
  let fetched = 0;
  let cached = 0;
  let failed = 0;

  const BATCH = 20;
  for (let i = 0; i < allIds.length; i += BATCH) {
    const batch = allIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (id) => {
      // Use cached version if available
      if (existing[id]) {
        manifest[id] = existing[id];
        cached++;
        return;
      }

      const dims = await fetchDimensions(id);
      if (dims) {
        manifest[id] = dims;
        fetched++;
      } else {
        failed++;
      }
    }));
    const done = Math.min(i + BATCH, allIds.length);
    process.stdout.write(`  ${done}/${allIds.length} processed\r`);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(manifest) + '\n');

  console.log(`\nDimensions complete: ${fetched} fetched, ${cached} cached, ${failed} failed`);
  console.log(`  Manifest: ${Object.keys(manifest).length} entries → ${OUT_FILE}\n`);
}

main().catch(err => {
  console.error('Dimensions generation failed:', err);
  process.exit(1);
});
