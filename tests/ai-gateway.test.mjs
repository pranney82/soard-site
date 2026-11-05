import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { viaGateway, aiCapped } from '../functions/api/_ai.js';

const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((f) => {
  const path = join(dir, f.name);
  if (f.isDirectory()) return sources(path);
  return f.name.endsWith('.js') ? [path] : [];
});

test('a call goes through the site’s gateway, saves no words, and names its feature', () => {
  assert.deepEqual(viaGateway('mail-sweep'), {
    gateway: { id: 'soard-site', collectLog: false, metadata: { feature: 'mail-sweep' } },
    tags: ['soard-site:mail-sweep'],
  });
});

test('every Workers AI call in the site carries viaGateway', () => {
  let calls = 0;
  for (const file of sources('functions')) {
    if (file.endsWith('_ai.js')) continue;
    const text = readFileSync(file, 'utf8');
    const runs = text.match(/\.AI\??\.run\(|\bai\.run\(/g)?.length || 0;
    const routed = text.match(/viaGateway\('[a-z-]+'\)/g)?.length || 0;
    calls += runs;
    assert.equal(routed, runs, `${file}: ${runs} AI call(s), ${routed} through viaGateway`);
  }
  assert.ok(calls >= 20, `expected the site's AI calls, found ${calls}`);
});

test('a cap Cloudflare reached is told from any other failure (the words are Cloudflare’s, from a live test Nov 5 2026)', () => {
  assert.equal(aiCapped(new Error("2045: Spend limit exceeded: rule 'site-day' (cost limit 5 per 86400s, sliding) for internal-workers-ai @cf/x")), true);
  assert.equal(aiCapped(new Error('2003: Rate limited')), true);
  assert.equal(aiCapped(new Error('Workers AI took too long')), false);
  assert.equal(aiCapped(new Error('3040: Capacity temporarily exceeded')), false);
  assert.equal(aiCapped(null), false);
});
