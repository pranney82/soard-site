#!/usr/bin/env node
/**
 * The shape of every event photo, so the recap gallery lays photos out at
 * their real proportions with no jump as they load (src/components/events/
 * RecapPhotos.astro). Covers each event's own photos and the Gala and Golf
 * page galleries (a series event's recap can show those, see
 * public/admin/events-shared.js).
 *
 * Fetches a 128px JPEG of each photo from Cloudflare Images and reads its
 * size; known photos are kept from the last run, so a build only asks about
 * new uploads.
 *
 * Run: node scripts/generate-event-dimensions.js (part of prebuild)
 * Output: src/data/dimensions-events.json → { "gallery/gala/1790…-dsc.jpg": [128, 85], … }
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { cfId, CF_BASE } from './cf-image-shared.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const EVENTS_DIR = join(ROOT, 'src', 'content', 'events');
const SITE_DIR = join(ROOT, 'src', 'content', 'site');
const OUT_FILE = join(ROOT, 'src', 'data', 'dimensions-events.json');

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** Width and height from a JPEG's frame header */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

async function probe(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${CF_BASE}/${id}/w=128,q=1,format=jpeg`);
      if (res.status === 404) return null;
      if (!res.ok) continue;
      return jpegSize(Buffer.from(await res.arrayBuffer()));
    } catch { /* try once more */ }
  }
  return null;
}

async function main() {
  const ids = new Set();
  if (existsSync(EVENTS_DIR)) {
    for (const f of readdirSync(EVENTS_DIR).filter((x) => x.endsWith('.json'))) {
      const ev = readJson(join(EVENTS_DIR, f));
      for (const p of ev?.photos || []) if (p?.id) ids.add(cfId(p.id));
    }
  }
  for (const doc of ['gala', 'golf']) {
    for (const p of readJson(join(SITE_DIR, `${doc}.json`))?.galleryPhotos || []) {
      const id = typeof p === 'string' ? p : p?.id;
      if (id) ids.add(cfId(id));
    }
  }

  const existing = readJson(OUT_FILE) || {};
  const manifest = {};
  const todo = [];
  for (const id of ids) {
    if (!id) continue;
    if (existing[id]) manifest[id] = existing[id];
    else todo.push(id);
  }

  let failed = 0;
  const BATCH = 16;
  for (let i = 0; i < todo.length; i += BATCH) {
    await Promise.all(todo.slice(i, i + BATCH).map(async (id) => {
      const dims = await probe(id);
      if (dims) manifest[id] = dims;
      else failed++;
    }));
  }

  const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
  writeFileSync(OUT_FILE, JSON.stringify(sorted) + '\n');
  console.log(`Event photo shapes: ${Object.keys(sorted).length} known, ${todo.length - failed} new${failed ? `, ${failed} not found (shown at 3:2)` : ''}`);
}

main().catch((err) => {
  // Never stop a deploy over this: the gallery falls back to 3:2 tiles
  console.warn(`  ⚠ event photo shapes: ${err.message}`);
  if (!existsSync(OUT_FILE)) writeFileSync(OUT_FILE, '{}\n');
});
