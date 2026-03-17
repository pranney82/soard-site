#!/usr/bin/env node
/**
 * Migrate JSON content files → D1 database
 *
 * Usage:
 *   # Dry run (prints SQL statements):
 *   node scripts/migrate-to-d1.js --dry-run
 *
 *   # Execute against local D1:
 *   node scripts/migrate-to-d1.js | wrangler d1 execute soard-db --file=-
 *
 *   # Or generate a SQL file and run it:
 *   node scripts/migrate-to-d1.js > scripts/seed.sql
 *   wrangler d1 execute soard-db --file=scripts/seed.sql
 *
 *   # Execute against remote D1:
 *   node scripts/migrate-to-d1.js > scripts/seed.sql
 *   wrangler d1 execute soard-db --remote --file=scripts/seed.sql
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const CONTENT = join(ROOT, 'src', 'content');

const dryRun = process.argv.includes('--dry-run');

function esc(str) {
  if (str === null || str === undefined) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}

function readJsonDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const raw = readFileSync(join(dir, f), 'utf8');
      return { filename: f, slug: basename(f, '.json'), data: JSON.parse(raw), raw };
    });
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return { data: JSON.parse(raw), raw };
}

const sql = [];

// ─── Kids ──────────────────────────────────────────────────────────
const kids = readJsonDir(join(CONTENT, 'kids'));
for (const { slug, data } of kids) {
  sql.push(
    `INSERT OR REPLACE INTO kids (slug, name, year, status, featured, child_count, room_count, data) VALUES (` +
    `${esc(slug)}, ${esc(data.name)}, ${data.year ?? 'NULL'}, ${esc(data.status || 'completed')}, ` +
    `${data.featured ? 1 : 0}, ${data.childCount ?? 1}, ${data.roomCount ?? 1}, ` +
    `${esc(JSON.stringify(data))});`
  );
}

// ─── Partners ──────────────────────────────────────────────────────
const partners = readJsonDir(join(CONTENT, 'partners'));
for (const { slug, data } of partners) {
  sql.push(
    `INSERT OR REPLACE INTO partners (slug, name, tier, featured, data) VALUES (` +
    `${esc(slug)}, ${esc(data.name)}, ${esc(data.tier)}, ${data.featured ? 1 : 0}, ` +
    `${esc(JSON.stringify(data))});`
  );
}

// ─── Press ─────────────────────────────────────────────────────────
const press = readJsonDir(join(CONTENT, 'press'));
for (const { slug, data } of press) {
  sql.push(
    `INSERT OR REPLACE INTO press (slug, title, date, category, featured, data) VALUES (` +
    `${esc(slug)}, ${esc(data.title)}, ${esc(data.date)}, ${esc(data.category)}, ` +
    `${data.featured ? 1 : 0}, ${esc(JSON.stringify(data))});`
  );
}

// ─── Team ──────────────────────────────────────────────────────────
const team = readJsonDir(join(CONTENT, 'team'));
for (const { slug, data } of team) {
  sql.push(
    `INSERT OR REPLACE INTO team (slug, name, "group", order_num, data) VALUES (` +
    `${esc(slug)}, ${esc(data.name)}, ${esc(data.group)}, ${data.order ?? 0}, ` +
    `${esc(JSON.stringify(data))});`
  );
}

// ─── Events ────────────────────────────────────────────────────────
const events = readJsonDir(join(CONTENT, 'events'));
for (const { slug, data } of events) {
  sql.push(
    `INSERT OR REPLACE INTO events (slug, title, date, status, featured, data) VALUES (` +
    `${esc(slug)}, ${esc(data.title)}, ${esc(data.date)}, ${esc(data.status || 'upcoming')}, ` +
    `${data.featured ? 1 : 0}, ${esc(JSON.stringify(data))});`
  );
}

// ─── Community ─────────────────────────────────────────────────────
const community = readJsonDir(join(CONTENT, 'community'));
for (const { slug, data } of community) {
  sql.push(
    `INSERT OR REPLACE INTO community (slug, name, order_num, data) VALUES (` +
    `${esc(slug)}, ${esc(data.name)}, ${data.order ?? 0}, ` +
    `${esc(JSON.stringify(data))});`
  );
}

// ─── Articles ──────────────────────────────────────────────────────
const articles = readJsonDir(join(CONTENT, 'articles'));
for (const { slug, data } of articles) {
  sql.push(
    `INSERT OR REPLACE INTO articles (slug, title, featured, order_num, data) VALUES (` +
    `${esc(slug)}, ${esc(data.title)}, ${data.featured ? 1 : 0}, ${data.order ?? 0}, ` +
    `${esc(JSON.stringify(data))});`
  );
}

// ─── Site config ───────────────────────────────────────────────────
const siteFiles = ['settings', 'our-story', 'faq', 'media', 'financials'];
for (const key of siteFiles) {
  const file = readJsonFile(join(CONTENT, 'site', `${key}.json`));
  if (file) {
    sql.push(
      `INSERT OR REPLACE INTO site_config (key, data) VALUES (` +
      `${esc(key)}, ${esc(JSON.stringify(file.data))});`
    );
  }
}

// ─── Financials (PDF metadata for R2) ──────────────────────────────
// Parse from financials.json — URLs will be updated after R2 migration
const financialsFile = readJsonFile(join(CONTENT, 'site', 'financials.json'));
if (financialsFile && financialsFile.data.documents) {
  for (const doc of financialsFile.data.documents) {
    const id = doc.url.replace(/^\/financials\//, '').replace(/\.pdf$/, '');
    sql.push(
      `INSERT OR REPLACE INTO financials (id, title, year, type, url, source, file_size) VALUES (` +
      `${esc(id)}, ${esc(doc.title)}, ${doc.year ?? 'NULL'}, ${esc(doc.type)}, ` +
      `${esc(doc.url)}, ${esc(doc.source || 'local')}, ${esc(doc.fileSize)});`
    );
  }
}

// ─── Output ────────────────────────────────────────────────────────
const output = sql.join('\n');

if (dryRun) {
  console.log(`-- SOARD D1 Migration (dry run)`);
  console.log(`-- ${kids.length} kids, ${partners.length} partners, ${press.length} press`);
  console.log(`-- ${team.length} team, ${events.length} events, ${community.length} community`);
  console.log(`-- ${articles.length} articles, ${siteFiles.length} site configs`);
  console.log(`-- Total: ${sql.length} INSERT statements\n`);
}

console.log(output);
