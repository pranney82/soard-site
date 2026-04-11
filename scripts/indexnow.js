/**
 * IndexNow — Notify Bing/Yandex of updated pages after deploy.
 *
 * Usage:  node scripts/indexnow.js
 *
 * This reads the built sitemap to discover all URLs, then submits
 * them to IndexNow for near-instant indexing by Bing and Yandex.
 * Run this after every production deploy.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SITE = 'https://sunshineonaranneyday.com';
const KEY = '43765d2ef882d46c7b7bf4b46bfb4ded';
const KEY_LOCATION = `${SITE}/${KEY}.txt`;

// Parse sitemap to extract URLs
const sitemapPath = path.join(__dirname, '..', 'dist', 'sitemap-0.xml');
if (!fs.existsSync(sitemapPath)) {
  console.error('No sitemap found at dist/sitemap-0.xml — run astro build first.');
  process.exit(1);
}

const sitemap = fs.readFileSync(sitemapPath, 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

console.log(`Found ${urls.length} URLs in sitemap.`);

const payload = JSON.stringify({
  host: 'sunshineonaranneyday.com',
  key: KEY,
  keyLocation: KEY_LOCATION,
  urlList: urls,
});

const options = {
  hostname: 'api.indexnow.org',
  path: '/IndexNow',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  },
};

const req = https.request(options, (res) => {
  console.log(`IndexNow response: ${res.statusCode}`);
  if (res.statusCode === 200 || res.statusCode === 202) {
    console.log(`Successfully submitted ${urls.length} URLs to IndexNow.`);
  } else {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => { console.error('Response:', body); });
  }
});

req.on('error', (e) => { console.error('Request failed:', e.message); });
req.write(payload);
req.end();
