#!/usr/bin/env node
/**
 * Pre-build script: fetches all content from D1 via the Cloudflare REST API
 * and writes JSON files into src/content/ so Astro Content Collections work unchanged.
 *
 * This runs before `astro build` in the build pipeline.
 *
 * Required environment variables:
 *   CLOUDFLARE_ACCOUNT_ID  — your CF account ID
 *   CLOUDFLARE_API_TOKEN   — API token with D1:Read permission
 *   CLOUDFLARE_D1_ID       — the D1 database ID
 *
 * These are auto-available in Cloudflare Pages builds, or set them in your .env for local dev.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  CONTENT, loadEnv, getD1Credentials, getD1ApiUrl,
  queryD1, collections, ensureDir, countExistingFiles,
  writeCollection, writeSiteConfig,
} from './d1-helpers.js';

loadEnv();

const creds = getD1Credentials();

if (!creds.accountId || !creds.apiToken || !creds.dbId) {
  console.error('Missing required environment variables:');
  if (!creds.accountId) console.error('  - CLOUDFLARE_ACCOUNT_ID');
  if (!creds.apiToken) console.error('  - CLOUDFLARE_API_TOKEN');
  if (!creds.dbId) console.error('  - CLOUDFLARE_D1_ID');
  console.error('\nSet them in .env for local dev, or in CF Pages environment variables for production.');
  process.exit(1);
}

const apiUrl = getD1ApiUrl(creds);
const query = (sql) => queryD1(apiUrl, creds.apiToken, sql);

console.log('Prebuild: fetching content from D1 via REST API...\n');

let totalFiles = 0;
let usedFallback = false;

try {
  // Fetch all collections + site config in parallel
  const [collectionResults, siteRows] = await Promise.all([
    Promise.all(
      collections.map(async ({ table, dir }) => {
        try {
          const rows = await query(`SELECT slug, data FROM ${table}`);
          return { table, dir, rows };
        } catch (err) {
          console.warn(`  ⚠ ${dir}: skipped (${err.message})`);
          return { table, dir, rows: [], skipped: true };
        }
      })
    ),
    query('SELECT key, data FROM site_config'),
  ]);

  for (const { dir, rows, skipped } of collectionResults) {
    ensureDir(join(CONTENT, dir));

    if (skipped) {
      // Already warned in catch block — skip file writes, stale git files remain as fallback
    } else if (rows.length === 0) {
      console.warn(`  ⚠ ${dir}: 0 items (table may be empty or query failed silently)`);
    } else {
      console.log(`  ${dir}: ${rows.length} items`);
    }

    writeCollection(dir, rows);
    totalFiles += rows.length;
  }

  // ─── Site config ───────────────────────────────────────────────────
  writeSiteConfig(siteRows);
  console.log(`  site: ${siteRows.length} config files`);
  totalFiles += siteRows.length;

  // ─── Validation ────────────────────────────────────────────────────
  const kidsResult = collectionResults.find(r => r.dir === 'kids');
  if (kidsResult && kidsResult.rows.length === 0) {
    console.error('\nFATAL: kids table returned 0 rows — aborting build to prevent empty site.');
    process.exit(1);
  }

} catch (err) {
  // ─── Fallback: use stale JSON files already in git ─────────────────
  const staleKids = countExistingFiles('kids');

  if (staleKids > 0) {
    usedFallback = true;
    console.warn(`\n⚠ D1 UNREACHABLE: ${err.message}`);
    console.warn(`  Falling back to ${staleKids} existing kid files in git.`);
    console.warn('  Content may be stale — deploy again once D1 recovers.\n');

    for (const { dir } of collections) {
      totalFiles += countExistingFiles(dir);
    }
    const siteDir = join(CONTENT, 'site');
    if (existsSync(siteDir)) {
      totalFiles += readdirSync(siteDir).filter(f => f.endsWith('.json')).length;
    }
  } else {
    console.error(`\nFATAL: D1 unreachable and no existing content files to fall back to.`);
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

const suffix = usedFallback ? ' (stale fallback — D1 was unreachable)' : '';
console.log(`\nPrebuild complete: ${totalFiles} files in src/content/${suffix}\n`);
