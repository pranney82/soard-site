#!/usr/bin/env node
/**
 * Migrate financial PDFs from public/financials/ → R2 bucket
 *
 * Prerequisites:
 *   - R2 bucket "soard-files" created in Cloudflare dashboard
 *   - wrangler authenticated (`wrangler login`)
 *
 * Usage:
 *   # Dry run (lists files to upload):
 *   node scripts/migrate-pdfs-to-r2.js --dry-run
 *
 *   # Execute upload:
 *   node scripts/migrate-pdfs-to-r2.js
 *
 *   # After upload, update D1 URLs:
 *   node scripts/migrate-pdfs-to-r2.js --update-urls > scripts/update-urls.sql
 *   wrangler d1 execute soard-db --remote --file=scripts/update-urls.sql
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const FINANCIALS_DIR = join(ROOT, 'public', 'financials');
const BUCKET = 'soard-files';
const R2_PREFIX = 'financials/';

const dryRun = process.argv.includes('--dry-run');
const updateUrls = process.argv.includes('--update-urls');

// After R2 upload, generate SQL to update the financials table URLs
// You'll need to set R2_PUBLIC_URL to your R2 custom domain or public bucket URL
if (updateUrls) {
  const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://files.soardcharity.com';
  const files = readdirSync(FINANCIALS_DIR).filter(f => f.endsWith('.pdf'));
  for (const file of files) {
    const id = file.replace(/\.pdf$/, '');
    const newUrl = `${R2_PUBLIC_URL}/${R2_PREFIX}${file}`;
    const esc = (s) => `'${s.replace(/'/g, "''")}'`;
    console.log(
      `UPDATE financials SET url = ${esc(newUrl)}, source = 'r2' WHERE id = ${esc(id)};`
    );
  }
  // Also update the site_config financials entry
  console.log(`\n-- Update site_config financials entry separately after verifying URLs`);
  process.exit(0);
}

if (!existsSync(FINANCIALS_DIR)) {
  console.error('No public/financials/ directory found');
  process.exit(1);
}

const files = readdirSync(FINANCIALS_DIR).filter(f => f.endsWith('.pdf'));
console.log(`Found ${files.length} PDFs to upload to R2 bucket "${BUCKET}"\n`);

for (const file of files) {
  const localPath = join(FINANCIALS_DIR, file);
  const r2Key = `${R2_PREFIX}${file}`;
  const size = readFileSync(localPath).byteLength;
  const sizeMb = (size / 1024 / 1024).toFixed(1);

  if (dryRun) {
    console.log(`[dry-run] Would upload: ${file} (${sizeMb} MB) → ${r2Key}`);
    continue;
  }

  console.log(`Uploading: ${file} (${sizeMb} MB) → ${r2Key}`);
  try {
    execSync(
      `npx wrangler r2 object put "${BUCKET}/${r2Key}" --file="${localPath}" --content-type="application/pdf" --remote`,
      { cwd: ROOT, stdio: 'inherit' }
    );
    console.log(`  ✓ Done\n`);
  } catch (err) {
    console.error(`  ✗ Failed to upload ${file}: ${err.message}\n`);
  }
}

console.log('\nUpload complete.');
console.log('Next steps:');
console.log('  1. Set up R2 public access or custom domain in Cloudflare dashboard');
console.log('  2. Run: R2_PUBLIC_URL=https://your-domain.com node scripts/migrate-pdfs-to-r2.js --update-urls > scripts/update-urls.sql');
console.log('  3. Run: wrangler d1 execute soard-db --remote --file=scripts/update-urls.sql');
