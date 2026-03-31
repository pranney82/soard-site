/**
 * Astro integration: D1 Dev Sync
 *
 * Polls Cloudflare D1 for content changes during `astro dev` and writes
 * updated JSON files to src/content/.  Astro's file watcher picks up
 * the changes automatically, so the browser hot-reloads.
 *
 * How it works:
 *   1. On config setup (before content load), runs a full sync from D1.
 *   2. Once the dev server is up, polls MAX(updated_at) per table every 5s.
 *   3. If a table changed since last check, re-fetches its rows and
 *      writes only the changed files.  Deleted items are removed.
 *
 * Uses the same D1 REST API and .env credentials as prebuild.js.
 */

import {
  loadEnv, getD1Credentials, getD1ApiUrl,
  queryD1, collections, writeCollection, writeSiteConfig,
} from './d1-helpers.js';

const POLL_INTERVAL = 5_000; // 5 seconds

// ── Sync state ─────────────────────────────────────────────────────
let apiUrl;
let apiToken;
let lastSync = {};
let syncing = false; // guard against overlapping polls

const query = (sql) => queryD1(apiUrl, apiToken, sql);

// ── Full sync ──────────────────────────────────────────────────────
async function fullSync() {
  console.log('[dev-sync] Full sync from D1...');

  const [collectionResults, siteRows] = await Promise.all([
    Promise.all(
      collections.map(async ({ table, dir }) => {
        try {
          const rows = await query(`SELECT slug, data FROM ${table}`);
          return { table, dir, rows };
        } catch (err) {
          console.warn(`[dev-sync]   ⚠ ${dir}: skipped (${err.message})`);
          return { table, dir, rows: [], skipped: true };
        }
      })
    ),
    query('SELECT key, data FROM site_config'),
  ]);

  for (const { dir, rows, skipped } of collectionResults) {
    if (skipped) continue;
    writeCollection(dir, rows, { deleteRemoved: true });
    console.log(`[dev-sync]   ${dir}: ${rows.length} items`);
  }

  writeSiteConfig(siteRows);
  console.log(`[dev-sync]   site: ${siteRows.length} config files`);

  await refreshTimestamps();
  console.log('[dev-sync] Full sync complete.\n');
}

// ── Timestamp tracking ─────────────────────────────────────────────
async function refreshTimestamps() {
  for (const { table } of collections) {
    try {
      const rows = await query(`SELECT MAX(updated_at) as latest FROM ${table}`);
      lastSync[table] = rows[0]?.latest || '';
    } catch { /* ignore */ }
  }
  try {
    const rows = await query(`SELECT MAX(updated_at) as latest FROM site_config`);
    lastSync['site_config'] = rows[0]?.latest || '';
  } catch { /* ignore */ }
}

// ── Incremental sync ───────────────────────────────────────────────
async function incrementalSync() {
  if (syncing) return; // skip if previous poll is still running
  syncing = true;
  try {
    for (const { table, dir } of collections) {
      try {
        const rows = await query(`SELECT MAX(updated_at) as latest FROM ${table}`);
        const latest = rows[0]?.latest || '';
        if (latest && latest !== lastSync[table]) {
          console.log(`[dev-sync] Change detected in "${dir}" — syncing...`);
          const dataRows = await query(`SELECT slug, data FROM ${table}`);
          writeCollection(dir, dataRows, { deleteRemoved: true });
          lastSync[table] = latest;
          console.log(`[dev-sync]   ${dir}: ${dataRows.length} items synced.`);
        }
      } catch { /* ignore — will retry next poll */ }
    }

    // Site config
    try {
      const rows = await query(`SELECT MAX(updated_at) as latest FROM site_config`);
      const latest = rows[0]?.latest || '';
      if (latest && latest !== lastSync['site_config']) {
        console.log('[dev-sync] Change detected in "site" — syncing...');
        const siteRows = await query('SELECT key, data FROM site_config');
        writeSiteConfig(siteRows);
        lastSync['site_config'] = latest;
        console.log(`[dev-sync]   site: ${siteRows.length} config files synced.`);
      }
    } catch { /* ignore */ }
  } finally {
    syncing = false;
  }
}

// ── Astro integration ──────────────────────────────────────────────
export default function devSyncIntegration() {
  let pollTimer;
  let d1Ready = false;

  return {
    name: 'dev-sync',
    hooks: {
      // Run initial sync BEFORE Astro reads content files
      'astro:config:setup': async () => {
        loadEnv();

        const creds = getD1Credentials();
        if (!creds.accountId || !creds.apiToken || !creds.dbId) {
          console.warn('[dev-sync] Missing D1 credentials in .env — skipping live sync.');
          return;
        }

        apiUrl = getD1ApiUrl(creds);
        apiToken = creds.apiToken;

        try {
          await fullSync();
          d1Ready = true;
        } catch (err) {
          console.warn(`[dev-sync] Full sync failed: ${err.message}`);
          console.warn('[dev-sync] Falling back to existing JSON files.');
        }
      },
      // Start polling once the dev server is up
      'astro:server:setup': () => {
        if (!d1Ready) return;

        pollTimer = setInterval(incrementalSync, POLL_INTERVAL);
        console.log(`[dev-sync] Watching D1 for changes (every ${POLL_INTERVAL / 1000}s)...\n`);
      },
      'astro:server:done': () => {
        if (pollTimer) clearInterval(pollTimer);
      },
    },
  };
}
