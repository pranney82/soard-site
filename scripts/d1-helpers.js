/**
 * Shared D1 helpers — used by both prebuild.js and dev-sync.js.
 * Single source of truth for .env loading, D1 queries, JSON parsing,
 * and content file writing.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { COLLECTION_MAP, isSiteDocKey, withoutScriptLinks } from '../functions/api/_collections.js';
import { SETTINGS_DEFAULTS } from './settings-defaults.js';

export const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = join(__dirname, '..');
// Record file names: the same rule the admin API enforces (functions/api/_collections.js SAFE_NAME)
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
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
    // A name with a slash or ".." would write outside the collection: never written
    if (!SAFE_FILE_NAME.test(String(row.slug || ''))) { console.warn(`  ⚠ skipped ${dir} row with an unsafe name: ${JSON.stringify(row.slug)}`); continue; }
    const filePath = join(outDir, `${row.slug}.json`);
    const data = safeParse(row.data);
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }
  if (FOCUS_DIRS.includes(dir)) writeFocusManifest();
}

// ── Photo focal points (src/data/focus-photos.json) ─────────────────
// Image ID → "0.42x0.31" for every kid and community project photo with a
// focal point set in the admin. src/utils/cf-image.ts crops those photos
// around it instead of the faces it finds. Written with every sync of either
// collection, from both as they are on disk, so dev and builds agree.
const CF_ID_RE = /^https?:\/\/(?:imagedelivery\.net|[^/]+\/cdn-cgi\/imagedelivery)\/[^/]+\/(.+?)(?:\/(?:public|[^/]*=[^/]*))?$/;
export function imageIdOf(url) {
  const s = String(url || '');
  const m = s.match(CF_ID_RE);
  return m ? m[1] : (/^https?:/.test(s) ? '' : s);
}
const FOCUS_DIRS = ['kids', 'community'];
export function photoFocusMap(records) {
  const out = {};
  for (const rec of records) {
    for (const p of rec?.photos || []) {
      const f = p?.focus;
      const id = imageIdOf(p?.url);
      if (!id || !f || !Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
      const c = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
      out[id] = `${c(f.x)}x${c(f.y)}`;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
function readCollection(dir) {
  const full = join(CONTENT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(readFileSync(join(full, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}
function writeFocusManifest() {
  const file = join(CONTENT, '..', 'data', 'focus-photos.json');
  const json = JSON.stringify(photoFocusMap(FOCUS_DIRS.flatMap(readCollection)), null, 2) + '\n';
  // Unchanged: leave the file alone (no rebuild in dev, no churn in git)
  if (existsSync(file) && readFileSync(file, 'utf8') === json) return;
  ensureDir(join(CONTENT, '..', 'data'));
  writeFileSync(file, json);
}

// ── Write site config to disk ──────────────────────────────────────
// Only the site docs (functions/api/_collections.js SITE_DOC_KEYS, the list the
// admin API serves): every other site_config row is runtime state a Function
// keeps in D1 (the live broadcast's config holds Stream and push keys), never
// read at build time, and never written into src/content or the build.
export function writeSiteConfig(siteRows) {
  const siteDir = join(CONTENT, 'site');
  ensureDir(siteDir);
  for (const row of siteRows) {
    const key = String(row.key || '');
    // Runtime state, not content (a doc key is always a safe file name). A copy
    // left from an older build, before the key was runtime-only, goes too
    if (!isSiteDocKey(key)) {
      const stale = SAFE_FILE_NAME.test(key) ? join(siteDir, `${key}.json`) : null;
      if (stale && existsSync(stale)) unlinkSync(stale);
      continue;
    }
    const filePath = join(siteDir, `${key}.json`);
    let data = safeParse(row.data);
    // Astro fails the whole build on a site entry that isn't an object, so a
    // doc saved as something else is skipped instead of breaking every deploy
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.warn(`  ⚠ site/${row.key}: not an object, skipped`);
      continue;
    }
    if (row.key === 'settings') data = deepMerge(SETTINGS_DEFAULTS, data);
    // Pages import these files directly, so a link that runs script (javascript:,
    // data:) is emptied here; save-content refuses them, so this is the backstop
    const cleaned = withoutScriptLinks(data);
    if (cleaned.dropped.length) console.warn(`  ⚠ site/${key}: left out links that aren't web addresses: ${cleaned.dropped.join(', ')}`);
    data = cleaned.data;
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }
}
