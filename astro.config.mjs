import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sunshineonaranneyday.com',
  output: 'static',
  compressHTML: true,
  integrations: [sitemap()],
  prefetch: {
    defaultStrategy: 'viewport',
  },
  build: {
    inlineStylesheets: 'auto',
  },
});
