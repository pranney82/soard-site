import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import devSync from './scripts/dev-sync.js';

const isDev = process.argv.includes('dev');

export default defineConfig({
  site: 'https://sunshineonaranneyday.com',
  output: 'static',
  compressHTML: true,
  integrations: [sitemap(), ...(isDev ? [devSync()] : [])],
  prefetch: {
    defaultStrategy: 'hover',
  },
  build: {
    inlineStylesheets: 'always',
  },
});
