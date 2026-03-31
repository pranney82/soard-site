/**
 * Shared D1 helpers — used by both prebuild.js and dev-sync.js.
 * Single source of truth for .env loading, D1 queries, JSON parsing,
 * and content file writing.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { COLLECTION_MAP } from '../functions/api/_collections.js';
import { SETTINGS_DEFAULTS } from './settings-defaults.js';

export const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = join(__dirname, '..');
export const CONTENT = join(ROOT, 'src', 'content');

export const collections = Object.values(COLLECTION_MAP).map(table => ({ table, dir: table }));

// ── .env loader ────────────────────────────────────────────────────
export function loadEnv() {
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
}

// ── Credentials ────────────────────────────────────────────────────
export function getD1Credentials() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const dbId = process.env.CLOUDFLARE_D1_ID || process.env.D1_DATABASE_ID;
  return { accountId, apiToken, dbId };
}

export function getD1ApiUrl({ accountId, dbId }) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;
}

// ── D1 query ───────────────────────────────────────────────────────
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export async function queryD1(apiUrl, apiToken, sql, attempt = 1) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (attempt <= MAX_RETRIES && res.status >= 500) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      return queryD1(apiUrl, apiToken, sql, attempt + 1);
    }
    throw new Error(`D1 API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  }

  return data.result?.[0]?.results || [];
}

// ── JSON parsing (handles D1 REST API quirks) ──────────────────────
export function safeParse(raw) {
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // D1 REST API quirks:
    // 1. Extra string-escaping (backslash-escaped quotes)
    // 2. Bare control characters inside JSON string values
    let cleaned = raw;
    if (cleaned.includes('\\"')) {
      cleaned = cleaned.replace(/\\"/g, '"');
    }
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (ch) => {
      const map = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
      return map[ch] || '';
    });
    return JSON.parse(cleaned);
  }
}

// ── Deep merge ─────────────────────────────────────────────────────
export function deepMerge(target, source) {
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

// ── Filesystem helpers ─────────────────────────────────────────────
export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function countExistingFiles(dir) {
  const fullDir = join(CONTENT, dir);
  if (!existsSync(fullDir)) return 0;
  return readdirSync(fullDir).filter(f => f.endsWith('.json')).length;
}

// ── Write a collection to disk (with optional delete of removed items) ──
export function writeCollection(dir, rows, { deleteRemoved = false } = {}) {
  const outDir = join(CONTENT, dir);
  ensureDir(outDir);

  if (deleteRemoved) {
    const dbSlugs = new Set(rows.map(r => r.slug));
    if (existsSync(outDir)) {
      for (const file of readdirSync(outDir).filter(f => f.endsWith('.json'))) {
        const slug = file.replace('.json', '');
        if (!dbSlugs.has(slug)) {
          unlinkSync(join(outDir, file));
        }
      }
    }
  }

  for (const row of rows) {
    const filePath = join(outDir, `${row.slug}.json`);
    const data = safeParse(row.data);
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }
}

// ── Write site config to disk ──────────────────────────────────────
export function writeSiteConfig(siteRows) {
  const siteDir = join(CONTENT, 'site');
  ensureDir(siteDir);
  for (const row of siteRows) {
    const filePath = join(siteDir, `${row.key}.json`);
    let data = safeParse(row.data);
    if (row.key === 'settings') data = deepMerge(SETTINGS_DEFAULTS, data);
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }
}
