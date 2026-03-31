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

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { COLLECTION_MAP } from '../functions/api/_collections.js';
import { SETTINGS_DEFAULTS } from './settings-defaults.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const CONTENT = join(ROOT, 'src', 'content');

// Load .env file if present (for local dev)
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
const DB_ID = process.env.CLOUDFLARE_D1_ID || process.env.D1_DATABASE_ID;

if (!ACCOUNT_ID || !API_TOKEN || !DB_ID) {
  console.error('Missing required environment variables:');
  if (!ACCOUNT_ID) console.error('  - CLOUDFLARE_ACCOUNT_ID');
  if (!API_TOKEN) console.error('  - CLOUDFLARE_API_TOKEN');
  if (!DB_ID) console.error('  - CLOUDFLARE_D1_ID');
  console.error('\nSet them in .env for local dev, or in CF Pages environment variables for production.');
  process.exit(1);
}

const D1_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function safeParse(raw) {
  if (typeof raw === 'object') return raw; // already parsed
  try {
    return JSON.parse(raw);
  } catch {
    // D1 REST API has two quirks:
    // 1. Extra string-escaping (backslash-escaped quotes around the whole value)
    // 2. Bare control characters inside JSON string values (e.g. literal newlines)
    // Try unescaping quotes first, then sanitize control characters.
    let cleaned = raw;
    // Strip outer escaped-quote layer: {\"key\":\"val\"} → {"key":"val"}
    if (cleaned.includes('\\"')) {
      cleaned = cleaned.replace(/\\"/g, '"');
    }
    // Escape bare control characters that aren't valid inside JSON strings
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (ch) => {
      const map = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
      return map[ch] || '';
    });
    return JSON.parse(cleaned);
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Deep-merge `source` into `target`.  Arrays and primitives from source
 * overwrite; plain objects recurse.  Returns a new object — no mutation.
 */
function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
        tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

async function queryD1(sql, attempt = 1) {
  const res = await fetch(D1_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (attempt <= MAX_RETRIES && res.status >= 500) {
      console.warn(`  D1 API returned ${res.status}, retrying (${attempt}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      return queryD1(sql, attempt + 1);
    }
    throw new Error(`D1 API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  }

  return data.result?.[0]?.results || [];
}

console.log('Prebuild: fetching content from D1 via REST API...\n');

// ─── Collection tables (derived from shared _collections.js) ──────
const collections = Object.values(COLLECTION_MAP).map(table => ({ table, dir: table }));

/**
 * Count existing JSON files in a content directory.
 * Used to check if stale git files can serve as fallback.
 */
function countExistingFiles(dir) {
  const fullDir = join(CONTENT, dir);
  if (!existsSync(fullDir)) return 0;
  return readdirSync(fullDir).filter(f => f.endsWith('.json')).length;
}

let totalFiles = 0;
let usedFallback = false;

try {
  // Fetch all collections + site config in parallel
  const [collectionResults, siteRows] = await Promise.all([
    Promise.all(
      collections.map(async ({ table, dir }) => {
        try {
          const rows = await queryD1(`SELECT slug, data FROM ${table}`);
          return { table, dir, rows };
        } catch (err) {
          console.warn(`  ⚠ ${dir}: skipped (${err.message})`);
          return { table, dir, rows: [], skipped: true };
        }
      })
    ),
    queryD1('SELECT key, data FROM site_config'),
  ]);

  for (const { dir, rows, skipped } of collectionResults) {
    const outDir = join(CONTENT, dir);
    ensureDir(outDir);

    if (skipped) {
      // Already warned in catch block — skip file writes, stale git files remain as fallback
    } else if (rows.length === 0) {
      console.warn(`  ⚠ ${dir}: 0 items (table may be empty or query failed silently)`);
    } else {
      console.log(`  ${dir}: ${rows.length} items`);
    }

    for (const row of rows) {
      const filePath = join(outDir, `${row.slug}.json`);
      const data = safeParse(row.data);
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      totalFiles++;
    }
  }

  // ─── Site config ───────────────────────────────────────────────────
  const siteDir = join(CONTENT, 'site');
  ensureDir(siteDir);
  console.log(`  site: ${siteRows.length} config files`);

  for (const row of siteRows) {
    const filePath = join(siteDir, `${row.key}.json`);
    let data = safeParse(row.data);
    // Guarantee every expected field exists — D1 may lag behind code changes
    if (row.key === 'settings') {
      data = deepMerge(SETTINGS_DEFAULTS, data);
    }
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    totalFiles++;
  }

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

    // Count all existing content for the summary
    for (const { dir } of collections) {
      totalFiles += countExistingFiles(dir);
    }
    const siteDir = join(CONTENT, 'site');
    if (existsSync(siteDir)) {
      totalFiles += readdirSync(siteDir).filter(f => f.endsWith('.json')).length;
    }
  } else {
    // No fallback possible — abort
    console.error(`\nFATAL: D1 unreachable and no existing content files to fall back to.`);
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

const suffix = usedFallback ? ' (stale fallback — D1 was unreachable)' : '';
console.log(`\nPrebuild complete: ${totalFiles} files in src/content/${suffix}\n`);
