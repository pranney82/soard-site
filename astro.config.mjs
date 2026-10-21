import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import devSync from './scripts/dev-sync.js';

const isDev = process.argv.includes('dev');
// Cache-busted so a config reload picks up edits: Astro re-imports this file
// on change, but Node keeps its static imports cached for the whole process
const devLiveMock = isDev ? (await import(`./scripts/dev-live-mock.js?t=${Date.now()}`)).default : null;

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
    // devLiveMock: fake broadcast + messages for the live pages in dev (/__live/?state=live|upcoming|starting|replay|off)
    ...(isDev ? [devSync(), devLiveMock()] : []),
  ],
  prefetch: {
    defaultStrategy: 'hover',
  },
  build: {
    // 'auto' inlines only small sheets; big page styles (the ~120 KB kid
    // template CSS) become cached external files instead of shipping
    // inside every HTML response.
    inlineStylesheets: 'auto',
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
