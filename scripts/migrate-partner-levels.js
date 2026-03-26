#!/usr/bin/env node
/**
 * Migration: Partner tier → level + category
 *
 * Reclassifies all 387 partner JSON files:
 *   - tier (top/construction/design/community) → removed
 *   - level (signature/champion/builder/friend) → added
 *   - category (build/design/funding/community) → added
 *   - tagline (string, optional) → added for signature partners
 *
 * Logic:
 *   1. Monetary sponsors ($10K+ hardcoded list) → level: 'champion', category: 'funding'
 *   2. In-kind champions (hardcoded list) → level: 'builder', keep original category
 *   3. featured: true (not already classified) → level: 'champion'
 *   4. Everything else → level: 'friend'
 *   5. Category mapping: construction→build, design→design, community→community
 *   6. Partners that appear in BOTH monetary AND in-kind → level: 'champion', category: 'funding'
 *
 * Run: node scripts/migrate-partner-levels.js
 * Dry run: node scripts/migrate-partner-levels.js --dry-run
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const PARTNERS_DIR = join(import.meta.dirname, '..', 'src', 'content', 'partners');

/* ── Hardcoded monetary sponsors from the old page (slugs where known) ── */
const MONETARY_SLUGS = new Set([
  'kids-r-kids',
  'pella',
  'jim-van-epps',
  'jm-wilkerson-construction',
  'mohawk',
  'msi',
  'beazer', 'beazer-homes',
  'jackson-healthcare',
  'stag-partners',
  'randall-paulson',
  'crosby-design-group',
  'real-floors-commercial',
]);

/* Names for monetary sponsors without slug matches */
const MONETARY_NAMES = new Set([
  'Sunshine Society',
  'Helen & Jimmy Carlos',
  'MCN/Babby',
  'Myfifident',
  '5 Arrows Farms/Walstads',
  'Constance Moscosco/Alcon Print',
  'Katherine & Max Dean',
  'Lee/Leo/Ducky Geary',
  'Spartan Surfaces',
  'Shaw Flooring',
  'Morrow Construction',
  'JC Foundation',
  'Scansource Foundation',
  'David, Helen, & Marian Woodward Foundation',
  'ST & Margaret D Harris Foundation',
  'Atlanta Foundation',
  'Georgia Power',
  'Trae Young Family Foundation',
  'Carlos & Sandy Ramirez',
  'Paul & Adro Nielsen',
]);

/* ── In-kind champions slugs ── */
const INKIND_SLUGS = new Set([
  'randall-paulson',
  'crosby-design-group',
  'real-floors-commercial',
  'cambria-black',
  'mohawk',
  'construction-resources',
  'top-knobs',
  'msi',
  'randall-brothers',
  'pella',
  'echols',
  'comfort-research',
  'sherwin-williams',
  'nothing-bundt-cakes',
  'lee-hainer',
  'pulley-and-associates',
  'artisan-design-studio',
  'niki-murphy-photography',
  'iframe-media',
]);

const INKIND_NAMES = new Set([
  'Walk Your Plans',
]);

/* ── Category mapping ── */
function mapCategory(oldTier) {
  switch (oldTier) {
    case 'construction': return 'build';
    case 'design': return 'design';
    case 'community': return 'community';
    case 'top': return 'build'; // 'top' was rarely used, default to build
    default: return 'build';
  }
}

/* ── Determine level for a partner ── */
function classifyPartner(data) {
  const isMonetary = MONETARY_SLUGS.has(data.slug) || MONETARY_NAMES.has(data.name);
  const isInKind = INKIND_SLUGS.has(data.slug) || INKIND_NAMES.has(data.name);

  // Monetary sponsors → champion + funding
  if (isMonetary) {
    return { level: 'champion', category: 'funding' };
  }

  // In-kind champions → builder, keep original category
  if (isInKind) {
    return { level: 'builder', category: mapCategory(data.tier) };
  }

  // Featured partners not in either list → champion
  if (data.featured) {
    return { level: 'champion', category: mapCategory(data.tier) };
  }

  // Everyone else → friend
  return { level: 'friend', category: mapCategory(data.tier) };
}

/* ── Main ── */
async function main() {
  const files = (await readdir(PARTNERS_DIR)).filter(f => f.endsWith('.json'));
  console.log(`\nMigrating ${files.length} partner files...`);
  if (DRY_RUN) console.log('(DRY RUN — no files will be modified)\n');

  const stats = { signature: 0, champion: 0, builder: 0, friend: 0 };
  const catStats = { build: 0, design: 0, funding: 0, community: 0 };

  for (const file of files) {
    const filePath = join(PARTNERS_DIR, file);
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);

    const { level, category } = classifyPartner(data);

    // Build new data object (preserving field order)
    const migrated = {
      name: data.name,
      slug: data.slug,
      logo: data.logo,
      ...(data.website ? { website: data.website } : {}),
      level,
      category,
      featured: data.featured ?? false,
      order: data.order ?? 0,
    };

    stats[level]++;
    catStats[category]++;

    if (DRY_RUN) {
      if (level !== 'friend') {
        console.log(`  ${data.name.padEnd(40)} ${data.tier.padEnd(14)} → ${level.padEnd(10)} ${category}`);
      }
    } else {
      await writeFile(filePath, JSON.stringify(migrated, null, 2) + '\n');
    }
  }

  console.log('\n── Summary ──');
  console.log(`  Signature:  ${stats.signature}`);
  console.log(`  Champion:   ${stats.champion}`);
  console.log(`  Builder:    ${stats.builder}`);
  console.log(`  Friend:     ${stats.friend}`);
  console.log(`  Total:      ${files.length}`);
  console.log('\n── Categories ──');
  console.log(`  Build:      ${catStats.build}`);
  console.log(`  Design:     ${catStats.design}`);
  console.log(`  Funding:    ${catStats.funding}`);
  console.log(`  Community:  ${catStats.community}`);
  console.log(`  Total:      ${files.length}`);
  if (DRY_RUN) console.log('\n(Dry run complete — run without --dry-run to apply changes)');
  else console.log('\nMigration complete!');
}

main().catch(err => { console.error(err); process.exit(1); });
