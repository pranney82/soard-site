import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import devSync from './scripts/dev-sync.js';

const isDev = process.argv.includes('dev');

export default defineConfig({
  site: 'https://sunshineonaranneyday.com',
  output: 'static',
  trailingSlash: 'always',
  compressHTML: true,
  integrations: [
    sitemap({
      filter: (page) =>
        !page.includes('/branding') &&
        !page.includes('/terms') &&
        !page.includes('/privacy-policy'),
      // No lastmod: stamping every URL with the build time makes the field
      // meaningless and Google ignores (or distrusts) uniform values.
    }),
    ...(isDev ? [devSync()] : []),
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
  },
});
