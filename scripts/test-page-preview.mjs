/**
 * test-page-preview.mjs — is the admin's Preview exactly the real page?
 * =====================================================================
 * For every kid, event, community project and article, rebuilds its page
 * inside a different item's page with the type's Preview module
 * (public/admin/<type>-preview.js, what Preview does with unsaved edits),
 * then compares the result with the item's real page: every element,
 * attribute and word of the page's content (rows listing other items are
 * left out, since they depend on the page it was built in). Items the build
 * gives no page are checked against the module's hasPage() rule instead.
 * Also checks that the template pages (/admin/<type>-template/*) still
 * render every part the previews clone.
 *
 * Run it after changing a page template under src/pages/, cf-image.ts,
 * reveals.ts or a *-preview.js module. Needs an Astro dev server:
 *
 *   SITE=http://localhost:4321 node scripts/test-page-preview.mjs
 *
 * Without SITE it starts `astro dev` on a spare port (in UTC, like Cloudflare's
 * builds) and stops it after; a SITE server should run with TZ=UTC too.
 * TYPES=kid,event limits the types; ONLY=<slug regex> limits the items.
 * Exits non-zero on any difference.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkStreamUid } from '../functions/api/stream-check.js';
import { FIXTURES } from '../src/pages/admin/_preview-fixtures.js';
import { normalizePerson, hasProfile } from '../public/admin/team-shared.js';

const ROOT = new URL('..', import.meta.url).pathname;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

// region: the part of the page compared; skip: parts that list other items
const TYPES = {
  kid: { dir: 'kids', path: (s) => `/kids/${s}/`, region: 'article.kid-profile', skip: ['.kids-strip', '.kid-news'], include: (k) => k.publishStatus !== 'draft',
    parts: {
      full: ['section.hero .hero__portrait .hero__badge--building', 'section.hero .hero__accent', 'section.hero .hero__cta',
        'section.hero .hero__reveal-link', '#reveal-modal [role="dialog"]', '#chapter-nav .chapter-nav__link[data-target="chapter-partners"]',
        'section.story #story-expand', 'section.story .story__para', 'section.story .story__quote', 'section.design .design__item',
        'section.design #design-view-all', 'section.design div[hidden] .masonry__item', 'section.ba-section .ba-slider .ba-slider__room',
        'section.reveal #stream-facade img', 'section.gallery .gallery__credit', 'section.gallery .gallery__cell--hero',
        'section.gallery #gallery .gallery__cell:not(.gallery__cell--hero) .gallery__counter', 'section.gallery #gallery-overflow .gallery__cell',
        'section.gallery #gallery-expand', 'section.village .village__logo img', 'section.page-cta .page-cta__btn[target]'],
      alt: ['section.hero .hero__badge--funding', 'section.reveal #yt-facade source', 'section.page-cta'],
      nophoto: ['.hero__portrait--empty .hero__placeholder-text'],
    } },
  // Past events are the recap (EventRecap.astro); gala and golf events forward to their series pages.
  // Rebuilt inside each other's template pages: the real ones may all be series events.
  event: { dir: 'events', path: (s) => `/events/${s}/`, region: 'main', skip: [], templateDonors: true,
    opts: () => ({ measure: false, partners: itemsOf('partners').map((x) => ({ slug: x.id, ...x.data })) }),
    parts: {
      upcoming: ['.ev-hero__meta-item:nth-child(3)', '.ev-hero__actions a[target]', '.ev-hero__visual img', 'section.ev-body .ev-body__content',
        'section.ev-video [data-stream-id] img', 'section.ev-gallery .ev-gallery__item img', 'section.ev-cta'],
      youtube: ['section.ev-video [data-yt-id] source'],
      past: ['div.rc', '.rh-photo[data-rp-jump="0"] img', '.rh-photo--small img', '.rh-highlights div', '.rh-ctas a[href="#sponsors"]', 'section.rp .rp-item',
        'section.rp .rp-credit a', '[data-rv] .rv-credit', 'section.rs .rs-tier--md', 'section.rs a.rs-card .rs-logo', 'section.rs .rs-name',
        'section.rs .rs-moment .rs-moment__sponsor > span', 'section.rc-video [data-yt-id]', 'section.rc-body', 'section.rc-close',
        'script[src*="RecapPhotos"]', 'script[src*="EventRecap"]'],
      pending: ['section.rc-pending', '.rh-photo--made'],
      poster: ['div.rh-photo img', 'section.rc-video [data-stream-id]'],
    } },
  community: { dir: 'community', path: (s) => `/community/${s}/`, region: 'main', skip: ['section.cp-detail-more'],
    parts: {
      full: ['.cp-detail-hero-photo img', '.cp-detail-hero-founded', '.cp-detail-stat', '.cp-detail-badge', '.cp-detail-story-body--rich',
        'section.cp-detail-quote blockquote p', 'section.cp-detail-video #stream-facade img', 'section.cp-detail-gallery .cp-detail-gallery-item img',
        'section.cp-detail-partners .cp-detail-partner-logo img', 'section.cp-detail-cta'],
      alt: ['.cp-detail-hero-color .cp-detail-hero-color-num', '.cp-detail-story-body:not(.cp-detail-story-body--rich) p', 'section.cp-detail-video #yt-facade source'],
    } },
  article: { dir: 'articles', path: (s) => `/resources/${s}/`, region: 'main article', skip: ['section.more'],
    parts: {
      full: ['section.hero .hero-frame img', 'section.hero .hero-meta-item', 'section.article-body .toc .toc-list li a .toc-num',
        'section.article-body .prose', 'section.faq details .faq-answer p', 'section.article-cta .article-cta-btns a'],
      nohero: ['section.hero .hero-frame img[srcset]'],
    } },
  // List pages: one page shows every item
  partner: { dir: 'partners', list: true, path: () => '/partners/', region: 'main', skip: [],
    parts: {
      full: ['a.sig-card .sig-card__tagline', 'div.sig-card .logo-placeholder', 'a.champ-card img', 'div.champ-card',
        'a.ap-card .ap-badge', 'a.ap-card .ap-card__tagline', 'div.ap-card .logo-placeholder', '.filter-tab__count'],
    } },
  press: { dir: 'press', list: true, path: () => '/publicity/', region: 'main', skip: [],
    parts: {
      video: ['section.fph .fph__poster', 'section.fph .fph__play', 'section.fpe .fpe__img', 'section.fpe .fpe__logo img',
        'section.fpe .fpe__logo--text span', '.archive__body details.yg .ci .ci__arrow'],
      image: ['section.fph .fph__img', 'section.fpe .fpe__poster'],
      logo: ['section.fph .fph__logo img'],
      text: ['section.fph .fph__logo--text span'],
    } },
  // Profile pages: one per person with a bio. Real ones are built inside each
  // other; the template variants inside each other (there may be no real ones yet)
  person: { dir: 'team', path: (s) => `/about/leadership/${s}/`, region: 'main', skip: [], templateDonors: true,
    include: (x) => hasProfile(normalizePerson(x)),
    opts: () => ({ collection: rawItems('team'), partners: rawItems('partners') }),
    parts: {
      full: ['section.hero .hero-org', 'section.hero .hero-ctas a[href*="linkedin"]', 'section.hero .hero-photo[style] img', 'section.hero .hero-logo img',
        'section.hero .hero-stat .hero-stat-label', 'section.hero h1 em', 'section.bio .bio-text p', '.fact .fact-partner', '.fact .fact-chips li', '.fact dd a[href*="linkedin"]',
        'section.words blockquote p', 'section.more .more-card img', 'section.more .more-card:not(:has(img))', 'section.more .more-all'],
      plain: ['section.hero .hero-placeholder img'],
    } },
  team: { dir: 'team', list: true, path: () => '/about/leadership/', region: 'main', skip: [],
    parts: {
      full: ['.board-card:not(.board-card--memorial) .board-photo[style]', '.board-card .board-photo:not([style])',
        '.board-card:not(.board-card--memorial):has(.board-org)', '.board-card--memorial .board-memorial',
        '.founder-card:has(.founder-photo[style])', '.founder-card .founder-photo:not([style])',
        '.member-card:not(.has-profile):has(.member-org):has(.member-photo[style])', '.member-card .member-photo:not([style])',
        '.board-card:not(.board-card--memorial):not(.has-profile):has(.board-org)', '.founder-card:not(.has-profile):has(.founder-photo[style])',
        '.has-profile .card-link', '.has-profile .card-more', '#advisory-board .board-grid'],
    } },
  // The Advisory Board page: its members section, from the advisors
  advisory: { dir: 'team', list: true, path: () => '/advisory-board/', region: 'main', skip: [],
    parts: {
      full: ['#members .abm-grid', '.abm-card', '.abm-photo[style] img', '.abm-photo:not([style]) .abm-initials', '.abm-memorial',
        '.abm-card:not(.has-profile) .abm-name', '.abm-link', '.abm-title', '.abm-org', '.abm-more'],
    } },
};
const only = process.env.TYPES ? process.env.TYPES.split(',') : Object.keys(TYPES);

let SITE = process.env.SITE?.replace(/\/$/, '');
let dev = null;
if (!SITE) {
  const port = 4300 + Math.floor(Math.random() * 600);
  // TZ=UTC: Cloudflare builds in UTC, and pages that group by year depend on it
  dev = spawn('npx', ['astro', 'dev', '--port', String(port)], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: 'UTC' } });
  SITE = `http://localhost:${port}`;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('astro dev did not start within 2 minutes')), 120000);
    const seen = (b) => { if (/Local\s+http/.test(String(b))) { clearTimeout(t); resolve(); } };
    dev.stdout.on('data', seen);
    dev.stderr.on('data', seen);
    dev.on('exit', (code) => { clearTimeout(t); reject(new Error(`astro dev exited (${code})`)); });
  });
}
const stopDev = () => { if (dev) try { process.kill(-dev.pid); } catch {} };
// Every item of a content folder, unfiltered, as the admin holds them
const rawItems = (dir) => {
  const d = join(ROOT, 'src/content', dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => ({ slug: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(d, f), 'utf8')) }));
};
const itemsOf = (t) => {
  const d = join(ROOT, 'src/content', TYPES[t]?.dir || t);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json'))
    .map((f) => ({ slug: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(d, f), 'utf8')) }))
    .filter((x) => x.slug && (!TYPES[t]?.include || TYPES[t].include(x)))
    .sort((a, b) => a.slug.localeCompare(b.slug));
};

const browser = await puppeteer.launch();
let failed = 0;
const page = await browser.newPage();
try {
  await page.exposeFunction('nodeStreamCheck', (uid) => checkStreamUid(uid));
  const workbench = async () => {
    // Any same-origin page will do as a workbench
    await page.goto(`${SITE}/admin/kid-manifests.json`);
    await page.evaluate(() => {
      // The dev server has no /api; answer the Stream check the way the build does
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const m = String(input?.url || input).match(/\/api\/stream-check\?uid=([^&]+)/);
        if (!m) return real(input, init);
        const state = await window.nodeStreamCheck(decodeURIComponent(m[1]));
        return new Response(JSON.stringify({ success: true, state }), { headers: { 'Content-Type': 'application/json' } });
      };
    });
  };
  await workbench();

  for (const type of only) {
    const cfg = TYPES[type];
    const all = itemsOf(type);
    const targets = all.filter((x) => !ONLY || ONLY.test(x.slug));
    const missing = await page.evaluate(async ({ type, parts }) => {
      const m = await import(`/admin/${type}-preview.js`);
      const { templates: T } = await m.loadKit();
      return Object.entries(parts).flatMap(([v, sels]) => sels.filter((s) => !T[v].querySelector(s)).map((s) => `${v}: ${s}`));
    }, { type, parts: cfg.parts });
    if (missing.length) {
      failed++;
      console.log(`✗ ${type} template pages are missing parts the preview clones:\n  ${missing.join('\n  ')}`);
    } else {
      console.log(`✓ ${type} template pages carry every part the preview clones`);
    }

    if (cfg.list) {
      // A list page has no other item's page to build inside, so cross-check:
      // the template page rebuilt from the real items must equal the real
      // page, and the real page rebuilt from the made-up items the template
      const flatItems = (list) => list.map((x) => ({ slug: x.id, ...x.data }));
      const realExtra = type === 'press' ? { mediaLogos: itemsOf('medialogos') } : {};
      let lx = 0;
      const variants = Object.entries(FIXTURES[type]);
      for (const [v, f] of variants) {
        const tpl = `/admin/${type}-template/${v}/`;
        const a = await compare({ type, item: null, realPath: cfg.path(), basePath: tpl, region: cfg.region, skip: cfg.skip, hasOwnPage: true,
          opts: { collection: all, ...realExtra } });
        const b = await compare({ type, item: null, realPath: tpl, basePath: cfg.path(), region: cfg.region, skip: cfg.skip, hasOwnPage: true,
          opts: { collection: flatItems(f.collection), mediaLogos: f.mediaLogos ? flatItems(f.mediaLogos) : [] } });
        if (a.ok) lx++; else { failed++; report(`${type}: the ${v} template rebuilt with the real ${all.length} items`, a); }
        if (b.ok) lx++; else { failed++; report(`${type}: the real page rebuilt with the ${v} template's items`, b); }
      }
      console.log(`${lx}/${variants.length * 2} ${type} list-page rebuilds match exactly (${all.length} real items)\n`);
      continue;
    }

    // Donors: items whose page exists
    const exists = {};
    for (const x of all) {
      const res = await fetch(`${SITE}${cfg.path(x.slug)}`).catch(() => null);
      // A forward (a redirect in dev, a meta refresh in a build) isn't a page of its own
      exists[x.slug] = !!res?.ok && !res.redirected && !/http-equiv="refresh"/i.test(await res.text());
    }
    const donors = all.filter((x) => exists[x.slug]);
    let passed = 0, compared = 0;
    for (const item of targets) {
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          r = await compare({ type, item, donors: donors.map((x) => x.slug), hasOwnPage: exists[item.slug], region: cfg.region, skip: cfg.skip, opts: cfg.opts?.() });
          break;
        } catch (err) {
          // The dev server can reload the workbench mid-run when files change
          if (attempt) throw err;
          await workbench();
        }
      }
      if (r.skip) continue;
      compared++;
      if (r.ok) { passed++; continue; }
      failed++;
      report(`${type} ${item.slug}`, r);
    }
    console.log(`${passed}/${compared} ${type} pages match the real page exactly${targets.length > compared ? ` (${targets.length - compared} without a page, as hasPage() predicts)` : ''}`);

    // The template pages' made-up items cover every variant
    let fx = 0;
    const variants = Object.entries(FIXTURES[type] || {});
    const flat = (list) => list?.map((x) => ({ slug: x.id, ...x.data }));
    for (const [i, [v, f]] of variants.entries()) {
      // templateDonors: rebuild each variant inside the next variant's template page
      const basePath = cfg.templateDonors ? `/admin/${type}-template/${variants[(i + 1) % variants.length][0]}/` : undefined;
      const r = await compare({ type, item: f.item, realPath: `/admin/${type}-template/${v}/`, basePath, donors: donors.map((x) => x.slug),
        hasOwnPage: true, region: cfg.region, skip: cfg.skip, opts: { measure: false, video: f.video, collection: flat(f.collection), partners: flat(f.partners) } });
      if (r.ok) fx++;
      else { failed++; report(`${type} template ${v}`, r); }
    }
    console.log(`${fx}/${variants.length} ${type} template variants match too\n`);
  }
} catch (err) {
  failed++;
  console.error(err);
} finally {
  await browser.close();
  stopDev();
}
console.log(failed ? `${failed} problem${failed > 1 ? 's' : ''}` : 'all checks passed');
process.exit(failed ? 1 : 0);

function report(what, r) {
  console.log(`✗ ${what}${r.donor ? ` (inside ${r.donor}'s page)` : ''} differs at line ${r.line}:`);
  console.log(`  real page:\n    ${r.real.join('\n    ')}\n  preview:\n    ${r.preview.join('\n    ')}`);
}

// Rebuild `item` inside a donor's page and compare with its real page
async function compare(args) {
  return page.evaluate(async ({ type, item, donors = [], hasOwnPage, region, skip, realPath, basePath, opts }) => {
            const m = await import(`/admin/${type}-preview.js`);
            if (!hasOwnPage) {
              return m.hasPage && m.hasPage(item) ? { ok: false, line: 0, real: ['(no page in the build)'], preview: ['hasPage() says it has one'] } : { skip: 'no page, and hasPage() agrees' };
            }
            if (item && m.hasPage && !m.hasPage(item)) return { ok: false, line: 0, real: ['(page exists)'], preview: ['hasPage() says it has none'] };
            const donor = basePath ? null : donors[(donors.indexOf(item.slug) + 1) % donors.length];
            const kit = await m.loadKit();
            const parse = async (path) => new DOMParser().parseFromString(await (await fetch(path)).text(), 'text/html');
            const [real, base] = await Promise.all([parse(realPath || m.pagePath(item.slug)), parse(basePath || m.pagePath(donor))]);
            const model = await m.buildModel(item, kit, opts || { measure: false });
            const win = { navigator: {}, fetch: () => {}, Response, open() {}, XMLHttpRequest: function () {} };
            win.XMLHttpRequest.prototype.open = () => {};
            m.patchPage(base, win, model);
            const flat = (doc) => {
              const el = doc.querySelector(region).cloneNode(true);
              skip.forEach((s) => el.querySelectorAll(s).forEach((n) => n.remove()));
              el.normalize();
              const out = [];
              const walk = (n, d) => {
                if (n.nodeType === 3) {
                  const t = n.nodeValue.replace(/\s+/g, ' ').trim();
                  if (t) out.push(`${'  '.repeat(d)}${JSON.stringify(t)}`);
                  return;
                }
                if (n.nodeType !== 1) return;
                const attrs = [...n.attributes].filter((a) => !a.name.startsWith('data-astro-source'))
                  .map((a) => `${a.name}=${JSON.stringify(a.value.replace(/\s+/g, ' ').trim())}`).sort();
                out.push(`${'  '.repeat(d)}<${n.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
                n.childNodes.forEach((c) => walk(c, d + 1));
              };
              walk(el, 0);
              return out;
            };
            const a = flat(real), b = flat(base);
            const at = a.findIndex((line, j) => line !== b[j]);
            if (at === -1 && a.length === b.length) return { ok: true, donor };
            const j = at === -1 ? Math.min(a.length, b.length) : at;
            return { ok: false, donor, line: j, real: a.slice(Math.max(0, j - 2), j + 3), preview: b.slice(Math.max(0, j - 2), j + 3) };
  }, args);
}
