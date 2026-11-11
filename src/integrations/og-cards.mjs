/**
 * Draws every page's share card after the pages are built (see
 * src/utils/og-registry.ts for how a page asks for one, og-card.ts for the
 * design).
 *
 * After `astro build`:
 *   1. every card a page wrote down is drawn into dist/og/ (several at once),
 *      and each page's link to it is set to /og/<path>.jpg?v=<the picture's own
 *      fingerprint>: the address changes exactly when the picture does;
 *   2. dist/og/index.json lists each page's card address (and key), for the
 *      server code that changes a page on the way out (/live/ during a reveal,
 *      the Control Room's preview) and for the next build;
 *   3. the old .png card addresses redirect to the new cards (dist/_redirects),
 *      so an old post's picture still shows;
 *   4. a page that only forwards to another (an event's old address) gets that
 *      page's preview, since not every app follows the forward;
 *   5. every page is checked: one card, one size, the file there, its address
 *      naming that very picture. If any isn't, the build stops, so a broken
 *      preview never goes live.
 *
 * Nothing is kept in the repository: a card is drawn from the same words and
 * photos its page shows, or, when the live site already has that very card
 * (same key, stamped inside the image, bytes matching its address), taken
 * from the live site.
 *
 * While `astro dev` runs, a card is drawn when it's asked for.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * The drawing and the card list are TypeScript (src/utils/og-build.ts). This
 * file is plain JavaScript so astro.config.mjs loads natively; the build
 * bundles that module for itself (esbuild, as scripts/build-worker.mjs does),
 * and the dev server loads it through Vite.
 */
const ENTRY = fileURLToPath(new URL('../utils/og-build.ts', import.meta.url));
async function bundled() {
  const out = path.resolve('node_modules/.cache/og-cards', `og-build-${process.pid}-${Date.now()}.mjs`);
  await build({ entryPoints: [ENTRY], bundle: true, format: 'esm', platform: 'node', outfile: out, packages: 'external', logLevel: 'silent' });
  try { return await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
}

const SITE = 'https://sunshineonaranneyday.com';

/** Cards for addresses the server makes rather than Astro (functions/) */
const SERVER_PAGES = [
  {
    // The link in the staff reveal texts (functions/control-room)
    page: '/control-room/',
    spec: { layout: 'text', eyebrow: 'Staff only', title: 'Reveal <em>Control Room</em>', lead: 'Sound, picture and every destination for the live reveal.', leadItalic: true },
  },
];

/** Where each page's card used to be (a .png), for the redirects (a kid's live page never had its own) */
function legacyAddresses(e) {
  if (/^\/live\/[^/]+\/$/.test(e.page) || e.page.startsWith('/admin/')) return [];
  const out = new Set([e.file.replace(/\.jpg$/, '.png')]);
  const people = e.page.match(/^\/about\/leadership\/([^/]+)\/$/);
  if (people) out.add(`/og/people/${people[1]}.png`);
  const ALIASES = {
    '/about/financials/': '/og/financials.png',
    '/about/leadership/': '/og/leadership.png',
    '/apply/community-project/': '/og/community-project.png',
    '/events/golf/': '/og/golf.png',
  };
  if (ALIASES[e.page]) out.add(ALIASES[e.page]);
  return [...out];
}

/** The live site's list of cards (page → { url, key }), or none */
async function liveCards() {
  try {
    const res = await fetch(`${SITE}/og/index.json`, { signal: AbortSignal.timeout(10000) });
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

/**
 * The live site's copy of a card, when it's this very picture: same key, its
 * stamp says so (photo and all), and its bytes are the fingerprint its address
 * names. Anything else is drawn.
 */
async function liveCard(og, e, liveEntry) {
  if (!liveEntry || liveEntry.key !== e.key || typeof liveEntry.url !== 'string') return null;
  try {
    const res = await fetch(`${SITE}${liveEntry.url}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const jpg = Buffer.from(await res.arrayBuffer());
    const named = new URL(liveEntry.url, SITE).searchParams.get('v');
    return (await og.hasStamp(jpg, e.key)) && og.fingerprint(jpg) === named ? jpg : null;
  } catch { return null; }
}

async function inParallel(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function htmlFiles(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== '_worker.js' && d.name !== '_astro') htmlFiles(p, out); }
    else if (d.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const metaContent = (html, attr, name) => [...html.matchAll(new RegExp(`<meta[^>]*${attr}="${name}"[^>]*>`, 'g'))]
  .map((m) => (m[0].match(/content="([^"]*)"/) || [])[1] ?? '');

/** @returns {import('astro').AstroIntegration} */
export default function ogCards() {
  return {
    name: 'soard-og-cards',
    hooks: {
      'astro:build:start': async () => (await bundled()).clearCards(),

      'astro:server:setup': ({ server }) => {
        server.middlewares.use(async (req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!/^\/og\/.+\.jpg$/.test(url)) return next();
          try {
            const og = await server.ssrLoadModule(ENTRY);
            const entry = og.readCards().find((e) => e.file === url);
            if (!entry) return next();
            const jpg = await og.renderCard(entry.spec);
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'no-store');
            res.end(jpg);
          } catch (e) { next(e); }
        });
      },

      'astro:build:done': async ({ dir, logger }) => {
        const dist = fileURLToPath(dir);
        const started = Date.now();
        const og = await bundled();
        const { readCards, registerCard, pagePath, drawCard, fingerprint, OG_W, OG_H } = og;
        for (const s of SERVER_PAGES) await registerCard(s.page, s.spec);
        const cards = readCards();
        if (!cards.length) throw new Error('Share cards: no page asked for a card (BaseLayout should register one for every page)');

        // 1. Draw them. A card the live site already has (same key, checked inside and
        //    out) is taken from there instead, so a build draws only what changed;
        //    anything else is drawn, photos from Cloudflare Images. Each card's
        //    address then names its own fingerprint.
        const live = await liveCards();
        const byKey = new Map();
        const noPhoto = [];
        const final = new Map(); // the address a page wrote (?v=key) → the card's real address (?v=fingerprint)
        let reused = 0;
        await inParallel(cards, Math.max(4, Math.min(12, (os.availableParallelism?.() ?? 4) * 2)), async (e) => {
          let jpg = await liveCard(og, e, live[e.page]);
          if (jpg) reused++;
          else {
            if (!byKey.has(e.key)) byKey.set(e.key, drawCard(e.spec));
            const drawn = await byKey.get(e.key);
            if (!drawn.photo) noPhoto.push(e.page);
            jpg = drawn.jpg;
          }
          const out = path.join(dist, e.file);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, jpg);
          final.set(e.url, `${e.file}?v=${fingerprint(jpg)}`);
        });
        const fellBack = noPhoto.length;
        const urlOf = (e) => final.get(e.url);

        // 2. Each page's card address (and key, for the next build), for the server code
        const index = {};
        for (const e of cards.sort((a, b) => a.page.localeCompare(b.page))) index[e.page] = { url: urlOf(e), key: e.key };
        fs.writeFileSync(path.join(dist, 'og', 'index.json'), JSON.stringify(index));

        // 3. Old .png addresses → the new cards
        const redirects = path.join(dist, '_redirects');
        const lines = cards.flatMap((e) => legacyAddresses(e).map((from) => `${from}  ${urlOf(e)}  301`));
        const existing = fs.existsSync(redirects) ? fs.readFileSync(redirects, 'utf8') : '';
        // Static rules go before the dynamic ones (splats/placeholders), so they're added at the top
        fs.writeFileSync(redirects, `# Share cards' old addresses (src/integrations/og-cards.mjs)\n${lines.join('\n')}\n\n${existing}`);

        // 4 + 5. Every page: forwarding pages get their target's preview; then all are checked
        const problems = [];
        const files = htmlFiles(dist);
        const listed = new Set();
        for (const f of fs.readdirSync(dist).filter((n) => /^sitemap-\d+\.xml$/.test(n))) {
          for (const m of fs.readFileSync(path.join(dist, f), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) listed.add(pagePath(new URL(m[1]).pathname));
        }
        if (!listed.size) problems.push('no sitemap to check the pages against (the sitemap integration runs first)');
        // Every page the sitemap lists is a page that was built (else it was never checked for a card)
        const built = new Set(files.map((f) => pagePath(path.relative(dist, f).split(path.sep).join('/').replace(/(^|\/)index\.html$/, '/').replace(/\.html$/, ''))));
        for (const p of listed) if (!built.has(p)) problems.push(`${p}: in the sitemap but not built, so its card can't be checked`);
        const pageOf = (file) => pagePath(path.relative(dist, file).split(path.sep).join('/').replace(/(^|\/)index\.html$/, '/').replace(/\.html$/, ''));
        // Every page links its card's real address
        const cardRef = /(https:\/\/sunshineonaranneyday\.com)?(\/og\/[^"?\s]+\.jpg\?v=[0-9a-f]+)/g;
        for (const file of files) {
          const before = fs.readFileSync(file, 'utf8');
          const after = before.replace(cardRef, (m, origin, ref) => (final.has(ref) ? `${origin || ''}${final.get(ref)}` : m));
          if (after !== before) fs.writeFileSync(file, after);
        }
        for (const file of files) {
          let html = fs.readFileSync(file, 'utf8');
          const refresh = html.match(/<meta http-equiv="refresh" content="\d+;url=([^"]+)"/i);
          const to = refresh ? new URL(refresh[1], SITE) : null;
          // A forward to a page of this site (never another site's) gets that page's preview
          if (to && to.origin === SITE && !/property="og:image"/.test(html)) {
            const targetFile = path.join(dist, pagePath(to.pathname), 'index.html');
            if (fs.existsSync(targetFile)) {
              const t = fs.readFileSync(targetFile, 'utf8');
              const tags = (t.match(/<meta (?:property="og:[^"]+"|name="twitter:[^"]+")[^>]*>/g) || []).join('');
              html = html.replace(/<\/title>/i, `</title>${tags}`);
              fs.writeFileSync(file, html);
            }
          }
          const page = pageOf(file);
          const og = metaContent(html, 'property', 'og:image');
          const tw = metaContent(html, 'name', 'twitter:image');
          // Every page in the sitemap needs a card; a page that isn't (a starting-soon screen, admin) only needs a right one if it has one
          if (!og.length && !listed.has(page)) continue;
          if (og.length !== 1) { problems.push(`${page}: ${og.length} og:image tags`); continue; }
          if (tw[0] !== og[0]) problems.push(`${page}: twitter:image differs from og:image`);
          const u = new URL(og[0], SITE);
          if (u.origin !== SITE) { problems.push(`${page}: card on another site (${og[0]})`); continue; }
          const local = path.join(dist, decodeURIComponent(u.pathname));
          if (!u.pathname.startsWith('/og/') || !fs.existsSync(local)) { problems.push(`${page}: card missing (${u.pathname})`); continue; }
          // The address names this very picture (so an app that kept an older one fetches it again)
          if (u.searchParams.get('v') !== fingerprint(fs.readFileSync(local))) problems.push(`${page}: card address ${u.pathname}?v=${u.searchParams.get('v')} isn't the picture there`);
          if (metaContent(html, 'property', 'og:image:width')[0] !== String(OG_W) || metaContent(html, 'property', 'og:image:height')[0] !== String(OG_H)) problems.push(`${page}: card size not ${OG_W}×${OG_H}`);
        }
        if (problems.length) {
          for (const p of problems.slice(0, 40)) logger.error(p);
          throw new Error(`Share cards: ${problems.length} page(s) with a missing or wrong card (first: ${problems[0]})`);
        }
        const bytes = cards.map((e) => fs.statSync(path.join(dist, e.file)).size);
        logger.info(`${cards.length} share cards for ${files.length} pages in ${((Date.now() - started) / 1000).toFixed(1)}s: ${cards.length - reused} drawn, ${reused} unchanged from the live site (largest ${Math.round(Math.max(...bytes) / 1024)} KB)`);
        if (fellBack) logger.warn(`Drawn without their photo (it didn't load from Cloudflare Images): ${noPhoto.join(', ')}`);
      },
    },
  };
}
