/**
 * The split server build (scripts/build-worker.mjs, scripts/worker/router.mjs):
 * the same routes as Cloudflare Pages would make from functions/, the same
 * router behavior, and a page loads only what it runs.
 * Run: node --test tests/build-worker.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { functionsConfig, routesJson, buildWorker, entrySource } from '../scripts/build-worker.mjs';
import { createWorker } from '../scripts/worker/router.mjs';

// ── Wrangler's own router (tests/fixtures/pages-template-worker.ts), runnable here ──
const original = (routes) => {
  globalThis.__routes = routes;
  const code = buildSync({
    stdin: { contents: `export const routes = globalThis.__routes;`, resolveDir: process.cwd(), loader: 'js', sourcefile: 'routes.js' },
    write: false, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent',
  }).outputFiles[0].text;
  const tpl = buildSync({
    entryPoints: ['tests/fixtures/pages-template-worker.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
    define: { __FALLBACK_SERVICE__: '"ASSETS"' }, inject: [], banner: { js: code.replace('export const routes', 'const routes') },
    mainFields: ['module', 'main'],
  }).outputFiles[0].text;
  return import(`data:text/javascript,${encodeURIComponent(tpl)}#${Math.random()}`).then((m) => m.default);
};

/** Handlers that write down what they saw, then do what the step says */
function scenario(log) {
  const h = (id, act = 'next') => async (ctx) => {
    log.push(`${id} ${ctx.request.method} ${new URL(ctx.request.url).pathname} fp=${ctx.functionPath} params=${JSON.stringify(ctx.params)} data=${JSON.stringify(ctx.data)}`);
    if (act === 'next') return ctx.next();
    if (act === 'rewrite') return ctx.next('/rewritten/', { method: 'POST' });
    if (act === 'data') { ctx.data = { ...ctx.data, seen: id }; return ctx.next(); }
    if (act === 'failopen') { ctx.passThroughOnException(); throw new Error('boom'); }
    if (act === 'throw') throw new Error('boom');
    if (act === 'notresponse') return 'nope';
    if (act === '304') return new Response(null, { status: 304 });
    if (act === 'wrap') { const r = await ctx.next(); return new Response(`[${id}]${await r.text()}`, r); }
    return new Response(`${id}:${act}`, { status: 200 });
  };
  return [
    { routePath: '/api/items/:id', mountPath: '/api/items', method: 'GET', middlewares: [], modules: [h('item-get', 'end')] },
    { routePath: '/api/items/:id', mountPath: '/api/items', method: 'POST', middlewares: [], modules: [h('item-post', 'end')] },
    { routePath: '/api/fail', mountPath: '/api', method: '', middlewares: [], modules: [h('fail', 'failopen')] },
    { routePath: '/api/throw', mountPath: '/api', method: '', middlewares: [], modules: [h('throw', 'throw')] },
    { routePath: '/api/bad', mountPath: '/api', method: '', middlewares: [], modules: [h('bad', 'notresponse')] },
    { routePath: '/api/same', mountPath: '/api', method: '', middlewares: [], modules: [h('same', '304')] },
    { routePath: '/kids/:path*', mountPath: '/kids', method: '', middlewares: [], modules: [h('kids-catchall', 'end')] },
    { routePath: '/kids', mountPath: '/kids', method: '', middlewares: [[h('kids-mw-a', 'data'), h('kids-mw-b', 'wrap')]], modules: [] },
    { routePath: '/api', mountPath: '/api', method: '', middlewares: [h('api-mw', 'next')], modules: [] },
    { routePath: '/rewritten', mountPath: '/', method: 'POST', middlewares: [], modules: [h('rewritten', 'end')] },
    { routePath: '/go', mountPath: '/', method: '', middlewares: [], modules: [h('go', 'rewrite')] },
    { routePath: '/', mountPath: '/', method: '', middlewares: [h('root-mw', 'wrap')], modules: [h('home', 'end')] },
  ];
}
// The same routes as loaders, the way the split build holds them
const lazy = (routes) => routes.map((r) => ({ ...r, middlewares: r.middlewares.map((x) => async () => x), modules: r.modules.map((x) => async () => x) }));

const REQUESTS = [
  ['GET', '/'], ['GET', '/api/items/42'], ['POST', '/api/items/42'], ['DELETE', '/api/items/42'], ['GET', '/api/fail'],
  ['GET', '/api/throw'], ['GET', '/api/bad'], ['GET', '/api/same'], ['GET', '/kids/'], ['GET', '/kids/max/'], ['GET', '/kids/a/b/c'],
  ['GET', '/go'], ['GET', '/donate/'], ['HEAD', '/kids/'], ['GET', '/api/'], ['GET', '/api/items/'], ['GET', '/kids%20x/'],
];

async function run(worker, method, path, log) {
  const env = { ASSETS: { fetch: async (req) => { log.push(`ASSETS ${req.method} ${new URL(req.url).pathname}`); return new Response(`asset ${new URL(req.url).pathname}`, { status: 200, headers: { 'x-from': 'assets' } }); } } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  try {
    const res = await worker.fetch(new Request(`https://example.org${path}`, { method }), env, ctx);
    return `${res.status} ${res.headers.get('x-from') || ''} ${method === 'HEAD' ? '' : await res.text()}`;
  } catch (e) {
    return `threw: ${e.message}`;
  }
}

test("the router does exactly what wrangler's does, request by request, loading handlers only when reached", async () => {
  for (const [method, path] of REQUESTS) {
    const a = []; const b = [];
    const theirs = await run(await original(scenario(a)), method, path, a);
    const mine = await run(createWorker(lazy(scenario(b))), method, path, b);
    assert.equal(mine, theirs, `${method} ${path}: the response`);
    assert.deepEqual(b, a, `${method} ${path}: every handler, in order, with what it saw`);
  }
  // Nothing is loaded that the request doesn't reach
  const loaded = [];
  const routes = scenario([]).map((r, i) => ({ ...r, middlewares: r.middlewares.map((x) => async () => { loaded.push(`mw${i}`); return x; }), modules: r.modules.map((x) => async () => { loaded.push(`mod${i}`); return x; }) }));
  await run(createWorker(routes), 'GET', '/api/items/7', []);
  assert.deepEqual(loaded.sort(), ['mod0', 'mw11', 'mw8'], 'only the site-wide and /api middlewares and the GET item handler');
});

test('the routes and _routes.json are the ones Cloudflare Pages makes from functions/', async (t) => {
  const config = await functionsConfig();
  assert.ok(config.routes.length > 100);
  // Kids pages: the bar, then the reveal day
  const kids = config.routes.find((r) => r.routePath === '/kids' && r.middleware);
  assert.deepEqual(kids.middleware, ['kids/_middleware.js:onRequest']);
  const json = routesJson(config.routes);
  assert.ok(json.include.includes('/kids/*') && json.include.includes('/api/*'));
  assert.ok(!json.include.includes('/*'), 'static files never run the server');
  let wrangler = null;
  try { wrangler = execFileSync('wrangler', ['--version'], { encoding: 'utf8' }).trim(); } catch { /* not installed */ }
  if (!wrangler) return t.skip('wrangler is not installed here; the comparison runs where it is');
  const dir = mkdtempSync(join(tmpdir(), 'wr-'));
  try {
    execFileSync('wrangler', ['pages', 'functions', 'build', '--outdir', join(dir, 'out'), '--output-config-path', join(dir, 'config.json'), '--output-routes-path', join(dir, 'routes.json')], { stdio: 'ignore' });
    assert.deepEqual(config.routes, JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).routes, `the route table wrangler ${wrangler} makes`);
    const theirs = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'));
    assert.deepEqual({ ...json, description: '' }, { ...theirs, description: '' }, `the _routes.json wrangler ${wrangler} makes`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page about SOARD loads a few dozen KB of server, not the whole server', async () => {
  const out = mkdtempSync(join(tmpdir(), 'split-'));
  try {
    const { metafile } = await buildWorker(out, { tmpDir: join(out, '.tmp') });
    const outs = metafile.outputs;
    const idx = Object.keys(outs).find((k) => k.endsWith('_worker.js/index.js'));
    const byEntry = Object.fromEntries(Object.entries(outs).filter(([, o]) => o.entryPoint).map(([k, o]) => [o.entryPoint, k]));
    const closure = (o, seen = new Set()) => { if (seen.has(o)) return seen; seen.add(o); for (const i of outs[o].imports) if (i.kind === 'import-statement' && outs[i.path]) closure(i.path, seen); return seen; };
    const kb = (s) => [...s].reduce((t, k) => t + outs[k].bytes, 0) / 1024;
    const total = Object.values(outs).reduce((t, o) => t + o.bytes, 0) / 1024;
    for (const page of ['functions/kids/_middleware.js', 'functions/index.js', 'functions/faq/_middleware.js', 'functions/api/application-open.js']) {
      const loads = kb(closure(byEntry[page], closure(idx)));
      assert.ok(loads < 150, `${page} loads ${loads.toFixed(0)} KB of ${total.toFixed(0)} KB`);
    }
    assert.ok(!Object.keys(outs).some((k) => /vendor-(heic|pdf)/.test(k)), "the admin pages' browser libraries stay out of the server");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the entry imports each handler on demand, never up front', async () => {
  const src = entrySource(await functionsConfig(), join(process.cwd(), 'functions'));
  assert.doesNotMatch(src, /^import .* from .*functions\//m, 'no handler is imported up front');
  assert.match(src, /once\(\(\) => import\(".*functions\/kids\/_middleware\.js"\)\.then\(\(m\) => m\["onRequest"\]\)\)/);
  assert.match(readFileSync('package.json', 'utf8'), /node scripts\/build-worker\.mjs/, 'npm run build runs it');
});
