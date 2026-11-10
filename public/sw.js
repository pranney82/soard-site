/**
 * Service Worker — Sunshine on a Ranney Day
 *
 * Two jobs, and it stays out of the way of everything else:
 * 1. Pages: straight from the network, with navigation preload (the request
 *    starts while the worker wakes, so a sleeping worker never delays a page),
 *    and a copy kept for when the visitor is offline. The copy is saved after
 *    the page is handed over, never before.
 * 2. Reveal reminders (Web Push), below.
 *
 * Fonts, scripts, styles and photos never come through here: the browser's own
 * cache already keeps them a year (public/_headers). In Chrome they skip the
 * worker entirely (static routing), so it doesn't even wake for them. It used
 * to copy them into its own caches, which only added a wait to every request;
 * activate clears those caches off visitors' devices.
 */
// v2: v1 could hold private pages (admin, family links); bumping the name clears it
const PAGE_CACHE_NAME = 'soard-pages-v2';
const PAGE_CACHE_MAX_ENTRIES = 60;

// Never kept on the device: signed-in pages, a family's application, and any
// page reached through a personal link (tokens in the query string)
const PRIVATE_PATHS = ['/admin', '/apply/form', '/profile-update', '/api/', '/cdn-cgi/access'];
const PRIVATE_PARAMS = ['t', 'token', 'confirm', 'unsubscribe', 'key', 'draft', 'resume'];
const isPrivate = (url) =>
  PRIVATE_PATHS.some((p) => url.pathname.startsWith(p)) || PRIVATE_PARAMS.some((k) => url.searchParams.has(k));

self.addEventListener('install', (event) => {
  // Chrome: only page loads reach this worker; every other request of this site goes straight to the network
  if (event.addRoutes) {
    event.waitUntil(event.addRoutes([
      { condition: { requestMode: 'navigate' }, source: 'fetch-event' },
      { condition: { urlPattern: '/*' }, source: 'network' },
    ]).catch(() => {}));
  }
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    // Only the offline pages are kept (the old asset and photo copies go)
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== PAGE_CACHE_NAME).map((k) => caches.delete(k)));
  })());
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Pages only: everything else goes to the network (and the browser's cache) untouched
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The admin's Preview (a fresh ?admin-preview URL per edit) and private pages are never kept
  const keep = !url.searchParams.has('admin-preview') && !isPrivate(url);
  event.respondWith(page(event, keep));
});

async function page(event, keep) {
  try {
    const response = (await event.preloadResponse) || (await fetch(event.request));
    const cacheControl = response.headers.get('Cache-Control') || '';
    if (keep && response.ok && !response.redirected && response.type === 'basic' && !/no-store|private/i.test(cacheControl)) {
      const copy = response.clone();
      event.waitUntil(keepPage(event.request, copy));
    }
    return response;
  } catch {
    const cached = keep ? await caches.match(event.request, { cacheName: PAGE_CACHE_NAME }) : null;
    return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

/** The offline copy, saved after the page is on screen; the oldest goes past 60 */
async function keepPage(request, response) {
  const cache = await caches.open(PAGE_CACHE_NAME);
  await cache.put(request, response);
  const keys = await cache.keys();
  if (keys.length > PAGE_CACHE_MAX_ENTRIES) await cache.delete(keys[0]);
}

// ─── Web Push (reveal reminders) ─────────────────────────────────────
// Payloads come from functions/api/_broadcast-notify.js reminderPush():
// { title, body, url, icon?, image?, tag? }
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Sunshine on a Ranney Day';
  const options = {
    body: data.body || '',
    icon: data.icon || '/apple-touch-icon.png',
    badge: '/favicon.svg',
    image: data.image || undefined,
    tag: data.tag || 'soard-reveal',
    renotify: true,
    data: { url: data.url || '/live/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url = (event.notification.data && event.notification.data.url) || '/live/';
  // Only ever open a page on this site
  try { if (new URL(url, self.location.origin).origin !== self.location.origin) url = '/live/'; } catch { url = '/live/'; }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        try { if (new URL(c.url).pathname === new URL(url, self.location.origin).pathname && 'focus' in c) return c.focus(); } catch {}
      }
      return self.clients.openWindow(url);
    })
  );
});
