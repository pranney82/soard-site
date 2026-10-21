/**
 * The generic content API and the build never hand out, save or publish
 * runtime state (functions/api/_collections.js SITE_DOC_KEYS): the live
 * broadcast's config holds Stream ingest keys and the push private key.
 * Links that run script are refused wherever content is saved, and a
 * collection name can't reach Object.prototype.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createD1 } from './lib/d1-shim.mjs';
import { SITE_DOC_KEYS, isSiteDocKey, parsePath, linkScheme, isWebLink, scriptLinks, withoutScriptLinks } from '../functions/api/_collections.js';
import { onRequestGet as readContent } from '../functions/api/read-content.js';
import { onRequestGet as listContent } from '../functions/api/list-content.js';
import { onRequestPost as saveContent } from '../functions/api/save-content.js';
import { onRequestPost as deleteContent } from '../functions/api/delete-content.js';
import { reorder } from '../functions/api/reorder-content.js';
import { rename } from '../functions/api/rename-content.js';
import { writeSiteConfig } from '../scripts/d1-helpers.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SECRET = 'live-input-secret-7f3a';
const PRIVATE_JWK = 'vapid-private-d-value-91bc';
const RUNTIME = {
  'broadcast-config': { liveInput: { uid: 'abc', rtmps: { streamKey: SECRET } }, vapid: { publicKey: 'pub', privateJwk: { d: PRIVATE_JWK } } },
  'broadcast-health': { webhook: { lastEvent: 'live' } },
  broadcast: { phase: 'idle' },
  'broadcast-schedule-lock': 0,
  'press-monitor-state': { scans: {} },
  'zeffy-alerts': { lastPaymentId: 'p1' },
  'replay-meta:abc': { uid: 'abc' },
};
const DOCS = { settings: { name: 'SOARD', email: 'info@soardcharity.com' }, faq: { items: [] }, 'email-template-recap': { subject: 'Thanks' } };

async function siteDb() {
  const DB = await createD1({ schemaFiles: [`${ROOT}scripts/schema.sql`] });
  await DB.exec('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  for (const [key, data] of Object.entries({ ...RUNTIME, ...DOCS })) {
    await DB.prepare('INSERT OR REPLACE INTO site_config (key, data) VALUES (?, ?)').bind(key, JSON.stringify(data)).run();
  }
  return DB;
}
const get = (handler, DB, q) => handler({ env: { DB }, request: new Request(`https://sunshineonaranneyday.com/api/x?${q}`), data: {} });
const post = (handler, DB, body) => handler({
  env: { DB }, data: { userEmail: 'staff@soardcharity.com' }, waitUntil: () => {},
  request: new Request('https://sunshineonaranneyday.com/api/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
});

test('site docs: the ones the admin edits; every runtime row a Function keeps is left out', () => {
  for (const k of SITE_DOC_KEYS) assert.ok(isSiteDocKey(k), k);
  assert.ok(isSiteDocKey('email-template-event-recap'));
  for (const k of ['email-template-', 'broadcast-config', 'broadcast-health', 'broadcast', 'broadcast-schedule', 'broadcast-schedule-lock', 'live-status',
    'press-monitor', 'press-monitor-state', 'reveal-invites', 'reveal-invites-guest-check', 'reveal-nudges', 'reveals', 'slack', 'slack-actions',
    'slack-preview', 'slack-preview-news', 'zeffy-alerts', 'fb-archive', 'replay-meta:abc', '__proto__', 'constructor', '../settings', 'settings/x']) {
    assert.equal(isSiteDocKey(k), false, k);
  }
  assert.equal(parsePath('src/content/site/broadcast-config.json'), null);
  assert.deepEqual(parsePath('src/content/site/email-template-recap.json'), { type: 'site', key: 'email-template-recap' });
});

test('every site_config key a Function writes for itself is runtime, not a doc', () => {
  const files = readdirSync(`${ROOT}functions/api`).filter((f) => f.endsWith('.js')).map((f) => `${ROOT}functions/api/${f}`);
  const keys = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!/site_config/.test(src)) continue;
    for (const m of src.matchAll(/\b[A-Z_]*KEY\s*=\s*'([a-z0-9-]+)'/g)) keys.add(m[1]);
  }
  assert.ok(keys.has('broadcast-config') && keys.has('press-monitor-state') && keys.size >= 15, [...keys].join(', '));
  for (const k of keys) assert.equal(isSiteDocKey(k), false, `${k} is runtime state: it must not be a site doc`);
});

test('every site doc the admin and the site use is on the list (a doc left off would stop saving)', () => {
  const used = new Set();
  const admin = `${ROOT}public/admin`;
  for (const f of readdirSync(admin).filter((x) => /\.(js|html)$/.test(x) && !/^vendor/.test(x))) {
    for (const m of readFileSync(`${admin}/${f}`, 'utf8').matchAll(/src\/content\/site\/([a-z0-9-]+)\.json/g)) used.add(m[1]);
  }
  const shared = readFileSync(`${admin}/site-config-shared.js`, 'utf8').match(/DOC_KEYS = \[([^\]]+)\]/)[1];
  for (const m of shared.matchAll(/'([a-z0-9-]+)'/g)) used.add(m[1]);
  // The build reads these (src/pages and components import them, golf/gala through getEntry)
  const tracked = execFileSync('git', ['ls-files', 'src/content/site'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).map((p) => p.split('/').pop().replace(/\.json$/, ''));
  for (const k of [...used, ...tracked, 'golf', 'gala']) assert.ok(isSiteDocKey(k), `${k} is used as a site doc but isn't in SITE_DOC_KEYS`);
});

test('read-content and list-content never return a runtime row', async () => {
  const DB = await siteDb();
  for (const [handler, q] of [[readContent, 'dir=src/content/site'], [listContent, 'dir=src/content/site']]) {
    const res = await get(handler, DB, q);
    const raw = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!raw.includes(SECRET) && !raw.includes(PRIVATE_JWK), 'no Stream or push secret');
    const names = (JSON.parse(raw).files || JSON.parse(raw).items).map((f) => f.name).sort();
    assert.deepEqual(names, ['email-template-recap.json', 'faq.json', 'settings.json']);
  }
  const one = await get(readContent, DB, 'path=src/content/site/broadcast-config.json');
  assert.equal(one.status, 403);
  assert.ok(!(await one.text()).includes(SECRET));
  assert.equal((await get(readContent, DB, 'path=src/content/site/broadcast-config.json&optional=1')).status, 403);
  const doc = await (await get(readContent, DB, 'path=src/content/site/settings.json')).json();
  assert.equal(JSON.parse(doc.content).name, 'SOARD');
});

test('save-content and delete-content refuse runtime rows (nothing written, nothing sent to GitHub)', async () => {
  const DB = await siteDb();
  const before = (await DB.prepare("SELECT data FROM site_config WHERE key = 'broadcast-config'").first()).data;
  const res = await post(saveContent, DB, { path: 'src/content/site/broadcast-config.json', content: JSON.stringify({ liveInput: null }), message: 'x' });
  assert.equal(res.status, 403);
  assert.equal((await DB.prepare("SELECT data FROM site_config WHERE key = 'broadcast-config'").first()).data, before);
  assert.equal((await post(deleteContent, DB, { path: 'src/content/site/broadcast-config.json', message: 'x' })).status, 403);
  assert.ok(await DB.prepare("SELECT key FROM site_config WHERE key = 'broadcast-config'").first());
  // A real doc still saves
  assert.equal((await post(saveContent, DB, { path: 'src/content/site/faq.json', content: JSON.stringify({ items: [{ q: 'Why?' }] }), message: 'FAQ' })).status, 200);
});

test('the build writes site docs only; a runtime row never lands in src/content', () => {
  const dir = `${ROOT}src/content/site`;
  const runtime = ['broadcast-config', 'zz-test-runtime-row', 'replay-meta:abc'];
  for (const k of runtime) assert.ok(!existsSync(`${dir}/${k}.json`), `${k}.json shouldn't exist before the test`);
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try { writeSiteConfig(runtime.map((key) => ({ key, data: JSON.stringify(RUNTIME['broadcast-config']) }))); } finally { console.warn = warn; }
  for (const k of runtime) assert.ok(!existsSync(`${dir}/${k}.json`), `${k}.json was written`);
  assert.deepEqual(warned, [], 'runtime rows are skipped quietly');
  // d1-helpers takes the list from _collections.js: no list of its own to fall out of step
  const helpers = readFileSync(`${ROOT}scripts/d1-helpers.js`, 'utf8');
  assert.match(helpers, /import \{[^}]*\bisSiteDocKey\b[^}]*\} from '\.\.\/functions\/api\/_collections\.js'/);
  assert.doesNotMatch(helpers, /RUNTIME_ONLY_KEYS/);
});

test('link schemes are read the way a browser reads them', () => {
  assert.equal(linkScheme('https://x.org'), 'https');
  assert.equal(linkScheme('  JaVa\tScRiPt:alert(1)'), 'javascript');
  assert.equal(linkScheme('\u0000\u001fjavascript:x'), 'javascript');
  assert.equal(linkScheme('java\nscript:x'), 'javascript');
  assert.equal(linkScheme('data:text/html,<script>'), 'data');
  assert.equal(linkScheme('/donate/'), '');
  assert.equal(linkScheme('kids/amari/photo.jpg'), '');
  assert.equal(linkScheme('#stories'), '');
  assert.equal(linkScheme('Accurate Lock & Hardware'), '');
  for (const ok of ['https://x.org/a', 'http://x.org', '/apply/', '#stories', '', 'kids/a/b.jpg', 'sunshineonaranneyday.com']) assert.ok(isWebLink(ok), ok);
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'vbscript:x', 'data:image/svg+xml,<svg>', 'mailto:a@b.c', 'file:///etc/passwd']) assert.equal(isWebLink(bad), false, bad);
  const doc = { url: 'https://ok', photos: [{ url: 'javascript:alert(1)' }], cta: { ctaHref: 'data:text/html,x', label: 'javascript:not a link field' }, website: 'VBScript:x', contactLink: 'mailto:a@b.c', heroImage: 'javascript:not-link-named' };
  assert.deepEqual(scriptLinks(doc).map((f) => f.path), ['photos[0].url', 'cta.ctaHref', 'website']);
  // What the build writes for a site doc (pages import those files directly): the same links emptied, the rest untouched
  const { data, dropped } = withoutScriptLinks(doc);
  assert.deepEqual(dropped, ['photos[0].url', 'cta.ctaHref', 'website']);
  assert.deepEqual(data, { ...doc, photos: [{ url: '' }], cta: { ctaHref: '', label: doc.cta.label }, website: '' });
  assert.equal(doc.photos[0].url, 'javascript:alert(1)', 'the original is left as it was');
  assert.deepEqual(withoutScriptLinks({ items: [] }), { data: { items: [] }, dropped: [] });
});

test('save-content refuses a link that runs script, in any link-named field at any depth', async () => {
  const DB = await siteDb();
  const save = (path, content) => post(saveContent, DB, { path, content: JSON.stringify(content), message: 'test' });
  const kid = { name: 'Ava', slug: 'ava', photos: [{ url: 'https://imagedelivery.net/h/kids/ava/1/public' }] };
  for (const bad of ['javascript:alert(document.cookie)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)']) {
    const res = await save('src/content/kids/ava.json', { ...kid, photos: [{ url: bad }] });
    assert.equal(res.status, 400, bad);
    assert.match((await res.json()).error, /photos\[0\]\.url/);
  }
  assert.equal((await save('src/content/press/x-2026-01-01.json', { title: 'X', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await save('src/content/partners/acme.json', { name: 'Acme', website: 'data:text/html,hi' })).status, 400);
  assert.equal((await save('src/content/site/settings.json', { homeHero: { cta2Link: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await save('src/content/events/gala.json', { title: 'Gala', ticketUrl: 'javascript:void(0)' })).status, 400);
  assert.equal(await DB.prepare("SELECT slug FROM kids WHERE slug = 'ava'").first(), null, 'nothing was written');
  // Web addresses, paths and image IDs save as before
  assert.equal((await save('src/content/kids/ava.json', { ...kid, photos: [{ url: 'kids/ava/1.jpg' }], videoUrl: 'https://youtu.be/x' })).status, 200);
  assert.equal((await save('src/content/site/settings.json', { homeHero: { cta1Link: '/apply/', cta2Link: '#stories' } })).status, 200);
});

test('a collection name never finds something on Object.prototype', async () => {
  const DB = await createD1({ schemaFiles: [`${ROOT}scripts/schema.sql`] });
  for (const collection of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const r = await reorder({ DB }, { collection, items: [{ slug: 'a', order: 0 }] });
    assert.equal(r.status, 403, `reorder ${collection}`);
    const n = await rename({ DB }, { collection, from: 'a', to: 'b' });
    assert.equal(n.status, 403, `rename ${collection}`);
  }
  assert.equal((await reorder({ DB }, { collection: ['team'], items: [{ slug: 'a', order: 0 }] })).status, 403, 'not a string');
  assert.notEqual((await reorder({ DB }, { collection: 'team', items: [{ slug: 'a', order: 0 }] })).status, 403, 'a real collection still works');
});
