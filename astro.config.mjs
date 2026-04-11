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
      serialize: (item) => {
        // Add lastmod to all sitemap entries
        item.lastmod = new Date().toISOString();
        return item;
      },
    }),
    ...(isDev ? [devSync()] : []),
  ],
  prefetch: {
    defaultStrategy: 'hover',
  },
  build: {
    inlineStylesheets: 'always',
  },
});
