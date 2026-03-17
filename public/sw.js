/**
 * Service Worker — Sunshine on a Ranney Day
 * Cache-first for static assets (fonts, images, CSS/JS).
 * Network-first for HTML pages (fresh content, offline fallback).
 */
const CACHE_NAME = 'soard-v2';

const PRECACHE_URLS = [
  '/fonts/outfit-latin-variable.woff2',
  '/fonts/libre-baskerville-latin-700-normal.woff2',
];

// Install: precache critical fonts
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: strategy based on request type
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests (except CF Images + fonts)
  if (request.method !== 'GET') return;

  const isSameOrigin = url.origin === self.location.origin;
  const isCFImage = url.hostname === 'imagedelivery.net';

  if (!isSameOrigin && !isCFImage) return;

  // Fonts & images: cache-first (immutable assets)
  if (
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname.match(/\.(woff2|png|jpg|jpeg|webp|avif|svg|ico)$/) ||
    isCFImage
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // CSS/JS hashed assets: cache-first
  if (url.pathname.match(/\/_astro\//)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // HTML pages: network-first with cache fallback
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirst(request));
    return;
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 408 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}
