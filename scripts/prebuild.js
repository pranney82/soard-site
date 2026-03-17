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

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

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
const DB_ID = process.env.CLOUDFLARE_D1_ID || process.env.D1_DATABASE_ID || '71ac037d-2682-4336-9cf7-234e97c5b462';

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variables.');
  console.error('Set them in .env for local dev, or in CF Pages environment variables for production.');
  process.exit(1);
}

const D1_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function queryD1(sql) {
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
    throw new Error(`D1 API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  }

  return data.result?.[0]?.results || [];
}

console.log('Prebuild: fetching content from D1 via REST API...\n');

// ─── Collection tables ─────────────────────────────────────────────
const collections = [
  { table: 'kids', dir: 'kids' },
  { table: 'partners', dir: 'partners' },
  { table: 'press', dir: 'press' },
  { table: 'team', dir: 'team' },
  { table: 'events', dir: 'events' },
  { table: 'community', dir: 'community' },
  { table: 'articles', dir: 'articles' },
];

let totalFiles = 0;

for (const { table, dir } of collections) {
  const outDir = join(CONTENT, dir);
  ensureDir(outDir);

  const rows = await queryD1(`SELECT slug, data FROM ${table}`);
  console.log(`  ${dir}: ${rows.length} items`);

  for (const row of rows) {
    const filePath = join(outDir, `${row.slug}.json`);
    const data = JSON.parse(row.data);
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    totalFiles++;
  }
}

// ─── Site config ───────────────────────────────────────────────────
const siteDir = join(CONTENT, 'site');
ensureDir(siteDir);

const siteRows = await queryD1('SELECT key, data FROM site_config');
console.log(`  site: ${siteRows.length} config files`);

for (const row of siteRows) {
  const filePath = join(siteDir, `${row.key}.json`);
  const data = JSON.parse(row.data);

  writeFileSync(filePath, JSON.stringify(data, null, 2));
  totalFiles++;
}

console.log(`\nPrebuild complete: ${totalFiles} files written to src/content/\n`);
