/**
 * The site's server code (functions/), built so each request loads only what it runs.
 *
 * Cloudflare Pages normally compiles functions/ into ONE script: about 7 MB
 * holding the whole server (board, W-9s, PDFs, the headless browser, …). Every
 * page that runs a Function (the application bar, a kid's reveal day, …) had to
 * start all of it on a cold server, which is where the 250–670 ms waits on
 * about one page view in ten came from.
 *
 * This builds the same functions/ into dist/_worker.js/ instead: a small core
 * (the router and the routes table) plus one module per handler, loaded the
 * first time a request needs it. Pages deploys a _worker.js folder as is and
 * then ignores functions/ (wrangler: `if (!_workerJS && existsSync(functions))`).
 *
 * What makes it the same server:
 * - routes:   functionsConfig() is wrangler's generateConfigFromFileTree, and
 *             routesJson() its _routes.json, ported line for line (4.86). The
 *             test compares both with wrangler's own output.
 * - router:   scripts/worker/router.mjs is wrangler's router with lazy loading
 *             and matchers built once. The test runs the two side by side.
 * - bundling: wrangler's esbuild settings (conditions workerd/worker/browser,
 *             es2024, .js as jsx, NODE_ENV production, node:* and cloudflare:*
 *             left to the runtime), plus splitting.
 *
 * Runs on Cloudflare's build (CF_PAGES=1) from `npm run build`. Locally it only
 * runs when asked (`node scripts/build-worker.mjs [outDir] --force`), so
 * `wrangler pages dev` keeps compiling functions/ live while you edit them. If it
 * can't build, it says so loudly and leaves functions/ to Pages, exactly as before.
 */

import { build } from 'esbuild';
import { readdir, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, extname, basename, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toUrlPath = (p) => p.split(sep).join('/');

// ── Routes from the file tree (wrangler src/pages/functions/filepath-routing.ts) ──

const validParamName = /^[A-Za-z0-9_]+$/;
function convertCatchallParams(routePath) {
  return routePath.replace(/\[\[([^\]]+)\]\]/g, (_, param) => {
    if (!validParamName.test(param)) throw new Error(`Invalid Pages function route parameter - "[[${param}]]"`);
    return `:${param}*`;
  });
}
function convertSimpleParams(routePath) {
  return routePath.replace(/\[([^\]]+)\]/g, (_, param) => {
    if (!validParamName.test(param)) throw new Error(`Invalid Pages function route parameter - "[${param}]"`);
    return `:${param}`;
  });
}

/** Breadth-first, in readdir order, like wrangler's forEachFile */
async function filesIn(baseDir) {
  const out = [];
  const queue = [baseDir];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(p);
      else if (entry.isFile()) out.push(p);
    }
  }
  return out;
}

export function compareRoutes({ routePath: a, method: methodA }, { routePath: b, method: methodB }) {
  const parse = (p) => p.slice(1).split('/').filter(Boolean);
  const sa = parse(a);
  const sb = parse(b);
  if (sa.length !== sb.length) return sb.length - sa.length;
  for (let i = 0; i < sa.length; i++) {
    const wa = sa[i].includes('*');
    const wb = sb[i].includes('*');
    const pa = sa[i].includes(':');
    const pb = sb[i].includes(':');
    if (wa && !wb) return 1;
    if (!wa && wb) return -1;
    if (pa && !pb) return 1;
    if (!pa && pb) return -1;
  }
  if (methodA && !methodB) return -1;
  if (!methodA && methodB) return 1;
  return a.localeCompare(b);
}

/** { routes: [{ routePath, mountPath, method, module?: ['file:export'], middleware?: [...] }] }, as wrangler writes it */
export async function functionsConfig(baseDir = join(ROOT, 'functions'), baseURL = '/') {
  if (!baseURL.startsWith('/')) baseURL = `/${baseURL}`;
  if (baseURL.endsWith('/')) baseURL = baseURL.slice(0, -1);
  let entries = [];
  for (const filepath of await filesIn(baseDir)) {
    const ext = extname(filepath);
    if (!/^\.(mjs|js|ts|tsx|jsx)$/.test(ext)) continue;
    const { metafile } = await build({ metafile: true, write: false, bundle: false, entryPoints: [resolve(filepath)], logLevel: 'silent' });
    const exportNames = [];
    for (const output in metafile?.outputs || {}) exportNames.push(...metafile.outputs[output].exports);
    for (const exportName of exportNames) {
      const [m, method = ''] = exportName.match(/^onRequest(Get|Post|Put|Patch|Delete|Options|Head)?$/) ?? [];
      if (!m) continue;
      const name = basename(filepath).slice(0, -ext.length);
      const isIndex = name === 'index';
      const isMiddleware = name === '_middleware' || name === '_middleware_';
      let routePath = relative(baseDir, filepath).slice(0, -ext.length);
      let mountPath = dirname(routePath);
      if (isIndex || isMiddleware) routePath = dirname(routePath);
      if (routePath === '.') routePath = '';
      if (mountPath === '.') mountPath = '';
      routePath = convertSimpleParams(convertCatchallParams(`${baseURL}/${routePath}`));
      mountPath = convertSimpleParams(convertCatchallParams(`${baseURL}/${mountPath}`));
      entries.push({
        routePath: toUrlPath(routePath),
        mountPath: toUrlPath(mountPath),
        method: method.toUpperCase(),
        [isMiddleware ? 'middleware' : 'module']: [`${toUrlPath(relative(baseDir, filepath))}:${exportName}`],
      });
    }
  }
  entries = entries.reduce((acc, { routePath, ...rest }) => {
    const existing = acc.find((e) => e.routePath === routePath && e.method === rest.method);
    if (existing) Object.assign(existing, rest);
    else acc.push({ routePath, ...rest });
    return acc;
  }, []);
  entries.sort(compareRoutes);
  return { routes: entries };
}

// ── _routes.json (wrangler routes-transformation.ts + routes-consolidation.ts) ──

const MAX_RULES = 100;
const MAX_RULE_LENGTH = 100;

function shortenRoute(routeToShorten, maxLength = MAX_RULE_LENGTH) {
  if (routeToShorten.length <= maxLength) return routeToShorten;
  let route = routeToShorten;
  for (let i = 0; i < routeToShorten.length; i++) {
    for (let j = maxLength - 1 - i; j > 0; j--) {
      if (route[j] === '/') {
        route = `${route.slice(0, j)}/*`;
        break;
      }
    }
    if (route.length <= maxLength) break;
  }
  return route.length > maxLength ? '/*' : route;
}
function consolidateRoutes(routes) {
  const shortened = Array.from(new Set(routes.map((r) => shortenRoute(r))));
  const map = new Map(shortened.map((r) => [r, true]));
  for (const route of shortened.filter((r) => r.endsWith('/*'))) {
    if (map.has(route)) {
      const trimmed = route.substring(0, route.length - 1);
      for (const next of map.keys()) if (next !== route && next.startsWith(trimmed)) map.delete(next);
    }
  }
  return Array.from(map.keys());
}
function compareGlobs(a, b) {
  const parse = (p) => p.slice(1).split('/').filter(Boolean);
  const sa = parse(a);
  const sb = parse(b);
  if (sa.length !== sb.length) return sb.length - sa.length;
  for (let i = 0; i < sa.length; i++) {
    const wa = sa[i].includes('*');
    const wb = sb[i].includes('*');
    if (wa && !wb) return 1;
    if (!wa && wb) return -1;
  }
  return a.localeCompare(b);
}

/** The paths that run the server; every other request is served straight from the static files */
export function routesJson(routes) {
  const globs = [...routes].reverse().map(({ routePath, middleware }) => {
    const globbed = routePath.replace(/:\w+\*?.*/, '*');
    if ((typeof middleware === 'string' || (Array.isArray(middleware) && middleware.length > 0)) && !globbed.endsWith('*')) {
      return toUrlPath(join(globbed, '*'));
    }
    return toUrlPath(globbed);
  });
  let include = consolidateRoutes(Array.from(new Set(globs)));
  if (include.length > MAX_RULES) include = ['/*'];
  include.sort((a, b) => compareGlobs(b, a));
  return { version: 1, description: 'Generated by scripts/build-worker.mjs (as wrangler would)', include, exclude: [] };
}

// ── The worker ──

/**
 * Admin page code the server shares (public/admin/board-shared.js, board/docs.js)
 * can load the browser's own libraries (vendor-heic.js, vendor-pdf.js: 4 MB) on
 * demand. The server never calls that code, so one-script bundling drops it; with
 * splitting, esbuild would still emit them as modules nothing loads. They stay
 * out: imported only if a browser-only path ever ran on the server, where they
 * couldn't work anyway.
 */
const browserOnly = {
  name: 'browser-only-vendor',
  setup(b) {
    b.onResolve({ filter: /(^|\/)vendor-[\w-]+\.js$/ }, (args) => (
      toUrlPath(args.importer).includes('/public/admin/') ? { path: args.path, external: true } : undefined
    ));
  },
};

/** The entry module: the routes table with a loader per handler, and the router */
export function entrySource(config, baseDir) {
  const loaders = new Map();
  const loaderFor = (spec) => {
    const [file, name = 'default'] = spec.split(':');
    const key = `${file}:${name}`;
    if (!loaders.has(key)) {
      const id = `load${loaders.size}`;
      const path = resolve(baseDir, file);
      loaders.set(key, { id, code: `const ${id} = once(() => import(${JSON.stringify(path)}).then((m) => m[${JSON.stringify(name)}]));` });
    }
    return loaders.get(key).id;
  };
  const rows = config.routes.map((r) => `  { routePath: ${JSON.stringify(r.routePath)}, mountPath: ${JSON.stringify(r.mountPath)}, method: ${JSON.stringify(r.method || '')}, middlewares: [${(r.middleware || []).map(loaderFor).join(', ')}], modules: [${(r.module || []).map(loaderFor).join(', ')}] },`);
  return `// Generated by scripts/build-worker.mjs from functions/. Do not edit.
import { createWorker } from ${JSON.stringify(join(ROOT, 'scripts/worker/router.mjs'))};
// Each handler module is imported the first time a request reaches it, once per server
const once = (load) => { let p; return () => (p ??= load().catch((e) => { p = undefined; throw e; })); };
${[...loaders.values()].map((l) => l.code).join('\n')}
const routes = [
${rows.join('\n')}
];
export default createWorker(routes, 'ASSETS');
`;
}

/** Build dist/_worker.js/ and dist/_routes.json. Returns what it wrote. */
export async function buildWorker(outDir = join(ROOT, 'dist'), { functionsDir = join(ROOT, 'functions'), tmpDir = join(ROOT, 'node_modules/.cache/soard-worker') } = {}) {
  const config = await functionsConfig(functionsDir);
  if (!config.routes.length) throw new Error('functions/ has no handlers');
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const entry = join(tmpDir, 'entry.mjs');
  await writeFile(entry, entrySource(config, functionsDir));
  const workerDir = join(outDir, '_worker.js');
  await rm(workerDir, { recursive: true, force: true });
  const result = await build({
    entryPoints: { index: entry },
    absWorkingDir: ROOT,
    bundle: true,
    splitting: true,
    format: 'esm',
    outdir: workerDir,
    chunkNames: 'chunks/[name]-[hash]',
    target: 'es2024',
    supported: { 'import-source': true },
    loader: { '.js': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx' },
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*', 'cloudflare:*'],
    define: {
      'process.env.NODE_ENV': '"production"',
      'global.process.env.NODE_ENV': '"production"',
      'globalThis.process.env.NODE_ENV': '"production"',
    },
    keepNames: true,
    minifySyntax: true,
    minifyWhitespace: true,
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
    plugins: [browserOnly],
  });
  const routes = routesJson(config.routes);
  await writeFile(join(outDir, '_routes.json'), `${JSON.stringify(routes, null, 2)}\n`);
  const files = Object.entries(result.metafile.outputs).map(([p, o]) => ({ path: relative(workerDir, resolve(ROOT, p)), bytes: o.bytes }));
  return { config, routes, files, metafile: result.metafile, workerDir };
}

// ── CLI ──

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const outDir = resolve(args.find((a) => !a.startsWith('--')) || join(ROOT, 'dist'));
  if (process.env.CF_PAGES !== '1' && !force) {
    console.log('[build-worker] local build: functions/ stays as is (pass --force to build the split server)');
    process.exit(0);
  }
  try {
    const { config, files, routes } = await buildWorker(outDir);
    const index = files.find((f) => f.path === 'index.js');
    const total = files.reduce((s, f) => s + f.bytes, 0);
    console.log(`[build-worker] ${config.routes.length} routes → _worker.js: index ${(index.bytes / 1024).toFixed(0)} KB + ${files.length - 1} modules (${(total / 1024 / 1024).toFixed(2)} MB in all); _routes.json ${routes.include.length} paths`);
  } catch (err) {
    // Never a broken deploy: without _worker.js, Pages compiles functions/ itself, as before
    await rm(join(outDir, '_worker.js'), { recursive: true, force: true }).catch(() => {});
    await rm(join(outDir, '_routes.json'), { force: true }).catch(() => {});
    console.error('\n[build-worker] ⚠️  COULD NOT BUILD THE SPLIT SERVER; Pages will compile functions/ as one script (slower cold starts).');
    console.error(err?.stack || err);
    console.error('');
  }
}
