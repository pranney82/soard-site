import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://sunshineonaranneyday.com',
  output: 'static',
  integrations: [sitemap(), react()],

  build: {
    inlineStylesheets: 'auto',
  },

  adapter: cloudflare(),
});