#!/usr/bin/env node
/**
 * migrate-partner-logos.mjs
 *
 * Migrates all partner JSON files from WordPress logo URLs
 * to Cloudflare Images URLs.
 *
 * How it works:
 *   1. Reads all partner JSON files
 *   2. For each with a WP logo URL:
 *      a. Checks if CF Images already has `partners/{slug}`
 *      b. If not, downloads the logo from WP and uploads to CF Images
 *      c. Updates the JSON file with the CF delivery URL
 *
 * Usage:
 *   node scripts/migrate-partner-logos.mjs
 *   node scripts/migrate-partner-logos.mjs --dry-run
 *
 * Requires: deployed site at SITE_URL with /api/upload-image and /api/list-images
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTNERS_DIR = path.join(__dirname, '..', 'src', 'content', 'partners');
const CF_BASE = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const SITE_URL = 'https://soard-site.pages.dev';
const DRY_RUN = process.argv.includes('--dry-run');

// Unsupported image formats for CF Images (will need conversion)
const UNSUPPORTED_EXT = ['.svg', '.pdf'];

// ── Step 1: Fetch existing CF Images with partners/ prefix ──────────

async function fetchExistingPartnerImages() {
  const existing = new Set();
  let page = 1;
  const perPage = 100;

  console.log('Fetching existing CF Images with partners/ prefix...');

  while (true) {
    const url = `${SITE_URL}/api/list-images?page=${page}&per_page=${perPage}&search=partners/`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.success || !data.images || data.images.length === 0) break;

    for (const img of data.images) {
      // img.id is like "partners/samsung" or "partners/tko-plumbing"
      existing.add(img.id);
    }

    process.stdout.write(`\r  Page ${page}: ${existing.size} partner images found`);

    if (data.images.length < perPage) break;
    page++;
  }

  console.log(`\n  Total: ${existing.size} partner images already in CF\n`);
  return existing;
}

// ── Step 2: Download image from URL ─────────────────────────────────

async function downloadImage(wpUrl) {
  const res = await fetch(wpUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${wpUrl}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

// ── Step 3: Upload image to CF Images ───────────────────────────────

async function uploadToCF(imageBuffer, filename, cfId) {
  const formData = new FormData();
  const blob = new Blob([imageBuffer]);
  formData.append('file', blob, filename);
  formData.append('id', cfId);

  const res = await fetch(`${SITE_URL}/api/upload-image`, {
    method: 'POST',
    body: formData,
  });

  const data = await res.json();
  if (!data.success) {
    throw new Error(data.error || 'Upload failed');
  }
  return data;
}

// ── Step 4: Process all partner JSON files ──────────────────────────

async function migrate() {
  const existingImages = await fetchExistingPartnerImages();

  const partnerFiles = fs.readdirSync(PARTNERS_DIR).filter(f => f.endsWith('.json'));
  console.log(`Processing ${partnerFiles.length} partner files...\n`);

  let alreadyCF = 0;
  let alreadyUploaded = 0;
  let uploaded = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  const skippedFiles = [];

  for (const file of partnerFiles) {
    const filePath = path.join(PARTNERS_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    let partner;
    try {
      partner = JSON.parse(raw);
    } catch (e) {
      console.log(`  ✗ ${file}: invalid JSON, skipping`);
      skipped++;
      continue;
    }

    // Skip if already on CF
    if (partner.logo && partner.logo.includes('imagedelivery.net')) {
      alreadyCF++;
      continue;
    }

    // Skip if no WP logo
    if (!partner.logo || !partner.logo.includes('sunshineonaranneyday.com')) {
      skipped++;
      skippedFiles.push({ file, reason: 'no WP logo URL' });
      continue;
    }

    const slug = partner.slug || file.replace('.json', '');
    const cfId = `partners/${slug}`;
    const cfDeliveryUrl = `${CF_BASE}/${cfId}/public`;

    // Check file extension
    const urlPath = new URL(partner.logo).pathname;
    const ext = path.extname(urlPath).toLowerCase();
    const isUnsupported = UNSUPPORTED_EXT.includes(ext);

    // Check if already exists in CF
    if (existingImages.has(cfId)) {
      // Already uploaded, just update JSON
      if (!DRY_RUN) {
        partner.logo = cfDeliveryUrl;
        fs.writeFileSync(filePath, JSON.stringify(partner, null, 2) + '\n', 'utf-8');
      }
      alreadyUploaded++;
      updated++;
      process.stdout.write(`\r  ✓ ${slug} (already in CF, JSON updated)          `);
      continue;
    }

    if (isUnsupported) {
      console.log(`\n  ⚠ ${slug}: unsupported format ${ext}, skipping upload`);
      skipped++;
      skippedFiles.push({ file, reason: `unsupported format: ${ext}` });
      continue;
    }

    // Download from WP and upload to CF
    if (DRY_RUN) {
      console.log(`\n  → ${slug}: would download & upload (dry run)`);
      continue;
    }

    try {
      const imageBuffer = await downloadImage(partner.logo);
      const filename = path.basename(urlPath);
      await uploadToCF(imageBuffer, filename, cfId);

      partner.logo = cfDeliveryUrl;
      fs.writeFileSync(filePath, JSON.stringify(partner, null, 2) + '\n', 'utf-8');

      uploaded++;
      updated++;
      process.stdout.write(`\r  ✓ ${slug} (downloaded + uploaded + JSON updated)          `);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      failed++;
      failures.push({ file, slug, error: err.message });
      console.log(`\n  ✗ ${slug}: ${err.message}`);
    }
  }

  console.log('\n\n════════════════════════════════════════');
  console.log(`  Total partner files:    ${partnerFiles.length}`);
  console.log(`  Already on CF:          ${alreadyCF}`);
  console.log(`  Already uploaded (JSON): ${alreadyUploaded}`);
  console.log(`  Newly uploaded:         ${uploaded}`);
  console.log(`  JSON files updated:     ${updated}`);
  console.log(`  Skipped:                ${skipped}`);
  console.log(`  Failed:                 ${failed}`);
  if (DRY_RUN) console.log('  Mode: DRY RUN (no changes)');
  console.log('════════════════════════════════════════\n');

  if (failures.length > 0) {
    console.log('Failures:');
    failures.forEach(f => console.log(`  - ${f.slug}: ${f.error}`));
    console.log('');
  }

  if (skippedFiles.length > 0) {
    console.log('Skipped:');
    skippedFiles.slice(0, 10).forEach(f => console.log(`  - ${f.file}: ${f.reason}`));
    if (skippedFiles.length > 10) console.log(`  ... and ${skippedFiles.length - 10} more`);
    console.log('');
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
