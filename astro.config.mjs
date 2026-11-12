import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import devSync from './scripts/dev-sync.js';
// Every page's share card, drawn after the pages are built (src/utils/og-card.ts)
import ogCards from './src/integrations/og-cards.mjs';

const isDev = process.argv.includes('dev');
// Cache-busted so a config reload picks up edits: Astro re-imports this file
// on change, but Node keeps its static imports cached for the whole process
const devLiveMock = isDev ? (await import(`./scripts/dev-live-mock.js?t=${Date.now()}`)).default : null;

// The browser scripts every public page loads share code: Astro's page router
// and prefetch (four files, one of them 27 bytes), the site's onPageLoad that
// every page script sets itself up through, and the site's live, reveal,
// sign-up and image helpers (five files). Split by module, a page fetched ~20
// script files, each found only after the one importing it arrived. One file
// instead, with the same code: the page router's script (the first on every
// page) imports it, so it's asked for as soon as that tiny script is in, not
// after a later script needing the helpers arrived (Nov 11 2026, a kid page
// over slow 4G: the helpers asked for at 1.09 s, in at 2.06 s). Every public
// page loads all of it already (the footer and the live card use the helpers).
const SHARED_CHUNKS = [
  ['shared', /[\\/]node_modules[\\/]astro[\\/]dist[\\/]|[\\/]src[\\/]utils[\\/](page-load|cf-image|live-client|live-banner|reveals-client|signup-check)\.ts$/],
];
function sharedScriptChunks() {
  return {
    name: 'shared-script-chunks',
    hooks: {
      'astro:build:setup': ({ target, updateConfig }) => {
        if (target !== 'client') return;
        updateConfig({
          build: {
            rollupOptions: {
              output: { manualChunks: (id) => SHARED_CHUNKS.find(([, re]) => re.test(id))?.[0] },
            },
          },
        });
      },
    },
  };
}

export default defineConfig({
  site: 'https://sunshineonaranneyday.com',
  output: 'static',
  trailingSlash: 'always',
  compressHTML: true,
  integrations: [
    sitemap({
      filter: (page) =>
        !page.includes('/admin/') &&
        !page.includes('/branding') &&
        !page.includes('/slate/') &&
        !page.includes('/terms') &&
        !page.includes('/privacy-policy') &&
        // Private bio form reached only from a link SOARD sends (also noindex)
        !page.includes('/profile-update'),
      // No lastmod: stamping every URL with the build time makes the field
      // meaningless and Google ignores (or distrusts) uniform values.
    }),
    // After sitemap: the check reads the sitemap it writes
    ogCards(),
    // devLiveMock: fake broadcast + messages for the live pages in dev (/__live/?state=live|upcoming|starting|replay|off)
    ...(isDev ? [devSync(), devLiveMock()] : []),
    sharedScriptChunks(),
  ],
  prefetch: {
    defaultStrategy: 'hover',
  },
  build: {
    // Every page's CSS goes in the page itself: the first paint never waits on
    // a stylesheet request racing the fonts and photos. Measured Nov 9 2026 on a
    // phone over slow 4G: first paint 1.12 s → 0.49 s on a kid's page, 0.83 s →
    // 0.48 s on the home page, for ~17 KB more (compressed) per page. ('auto'
    // kept big sheets, like the kid template's, as separate files.)
    inlineStylesheets: 'always',
  },
  vite: {
    server: {
      allowedHosts: ['.trycloudflare.com'],
    },
    build: {
      // Page scripts always ship as /_astro/*.js files, never inlined into the
      // HTML (Astro inlines ones under 4 KB): the CSP allows inline scripts
      // only by hash (scripts/csp-hash.mjs), and a file needs no hash.
      // undefined keeps Vite's default for everything else (small images, fonts).
      assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined),
    },
  },
});
