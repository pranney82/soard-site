#!/usr/bin/env node
/**
 * migrate-kid-images.mjs
 *
 * Migrates all kid JSON content files from WordPress image URLs
 * to Cloudflare Images URLs.
 *
 * How it works:
 *   1. Fetches ALL images from the CF Images API (via /api/list-images)
 *   2. Builds a lookup: original filename → CF image UUID
 *   3. For each kid JSON, replaces WP URLs in heroImage + photos[].url
 *   4. Writes updated JSON back to disk
 *
 * Usage:
 *   node scripts/migrate-kid-images.mjs
 *   node scripts/migrate-kid-images.mjs --dry-run   # preview without writing
 *
 * Requires: deployed site at SITE_URL with /api/list-images endpoint
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIDS_DIR = path.join(__dirname, '..', 'src', 'content', 'kids');
const CF_BASE = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const SITE_URL = 'https://soard-site.pages.dev';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Step 1: Fetch all CF Images and build filename → UUID map ────────

async function fetchAllCFImages() {
  const map = new Map(); // filename → CF image ID
  let page = 1;
  let totalFetched = 0;
  const perPage = 100;

  console.log('Fetching CF Images inventory...');

  while (true) {
    const url = `${SITE_URL}/api/list-images?page=${page}&per_page=${perPage}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.success || !data.images || data.images.length === 0) break;

    for (const img of data.images) {
      if (img.filename) {
        // Store by filename (case-sensitive)
        map.set(img.filename, img.id);
      }
    }

    totalFetched += data.images.length;
    process.stdout.write(`\r  Page ${page}: ${totalFetched} images indexed`);

    // If we got fewer than perPage, we've reached the last page
    if (data.images.length < perPage) break;
    page++;
  }

  console.log(`\n  Total: ${map.size} images with filenames mapped\n`);
  return map;
}

// ── Step 2: Extract filename from a WordPress URL ────────────────────

function extractFilename(wpUrl) {
  if (!wpUrl) return null;
  try {
    const urlObj = new URL(wpUrl);
    const parts = urlObj.pathname.split('/');
    return parts[parts.length - 1]; // e.g. "Oakley_2023_family_0003-e1710961594224.jpg"
  } catch {
    return null;
  }
}

// ── Step 3: Build CF Images URL from UUID ────────────────────────────

function cfUrl(uuid) {
  return `${CF_BASE}/${uuid}/public`;
}

// ── Step 4: Process all kid JSON files ───────────────────────────────

async function migrate() {
  const filenameToUuid = await fetchAllCFImages();

  const kidFiles = fs.readdirSync(KIDS_DIR).filter(f => f.endsWith('.json'));
  console.log(`Processing ${kidFiles.length} kid files...\n`);

  let totalUpdated = 0;
  let totalUrlsSwapped = 0;
  let totalMissing = 0;
  const missingFiles = [];

  for (const file of kidFiles) {
    const filePath = path.join(KIDS_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    let kid;
    try {
      kid = JSON.parse(raw);
    } catch (e) {
      console.log(`  ✗ ${file}: invalid JSON, skipping`);
      continue;
    }

    let changed = false;
    let swapped = 0;
    let missing = 0;

    // Migrate heroImage
    if (kid.heroImage && kid.heroImage.includes('sunshineonaranneyday.com')) {
      const filename = extractFilename(kid.heroImage);
      const uuid = filename ? filenameToUuid.get(filename) : null;
      if (uuid) {
        kid.heroImage = cfUrl(uuid);
        swapped++;
        changed = true;
      } else {
        missing++;
        missingFiles.push({ file, field: 'heroImage', filename });
      }
    }

    // Migrate photos array
    if (Array.isArray(kid.photos)) {
      for (const photo of kid.photos) {
        if (photo.url && photo.url.includes('sunshineonaranneyday.com')) {
          const filename = extractFilename(photo.url);
          const uuid = filename ? filenameToUuid.get(filename) : null;
          if (uuid) {
            photo.url = cfUrl(uuid);
            swapped++;
            changed = true;
          } else {
            missing++;
            missingFiles.push({ file, field: 'photos', filename });
          }
        }
      }
    }

    // Migrate partnerLogos array (some kids have WP partner logos)
    if (Array.isArray(kid.partnerLogos)) {
      for (const logo of kid.partnerLogos) {
        if (logo.url && logo.url.includes('sunshineonaranneyday.com')) {
          const filename = extractFilename(logo.url);
          const uuid = filename ? filenameToUuid.get(filename) : null;
          if (uuid) {
            logo.url = cfUrl(uuid);
            swapped++;
            changed = true;
          } else {
            missing++;
            missingFiles.push({ file, field: 'partnerLogos', filename });
          }
        }
      }
    }

    if (changed) {
      if (!DRY_RUN) {
        fs.writeFileSync(filePath, JSON.stringify(kid, null, 2) + '\n', 'utf-8');
      }
      totalUpdated++;
      totalUrlsSwapped += swapped;
      console.log(`  ✓ ${file}: ${swapped} URLs migrated${missing ? `, ${missing} missing` : ''}${DRY_RUN ? ' (dry run)' : ''}`);
    } else if (missing > 0) {
      console.log(`  ⚠ ${file}: 0 migrated, ${missing} missing in CF`);
    }

    totalMissing += missing;
  }

  console.log('\n════════════════════════════════════════');
  console.log(`  Files updated:  ${totalUpdated} / ${kidFiles.length}`);
  console.log(`  URLs swapped:   ${totalUrlsSwapped}`);
  console.log(`  Missing in CF:  ${totalMissing}`);
  if (DRY_RUN) console.log('  Mode: DRY RUN (no files written)');
  console.log('════════════════════════════════════════\n');

  if (missingFiles.length > 0) {
    console.log('Missing images (not found in CF):');
    const unique = [...new Set(missingFiles.map(m => m.filename))];
    unique.slice(0, 20).forEach(f => console.log(`  - ${f}`));
    if (unique.length > 20) console.log(`  ... and ${unique.length - 20} more`);
    console.log('');
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
