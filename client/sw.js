const CACHE_NAME = 'syncbeat-pwa-v4';
const APP_SHELL = [
  '/',
  '/index.html',
  '/mobile.html',
  '/room.html',
  '/room-mobile.html',
  '/style.css',
  '/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
  '/js/app.js',
  '/js/auth.js',
  '/js/device-router.js',
  '/js/room.js',
  '/js/supabase-client.js',
  '/js/ui.js',
];
const NETWORK_FIRST_PATHS = new Set([
  '/',
  '/index.html',
  '/mobile.html',
  '/room.html',
  '/room-mobile.html',
  '/style.css',
  '/manifest.webmanifest',
  '/js/app.js',
  '/js/auth.js',
  '/js/device-router.js',
  '/js/room.js',
  '/js/supabase-client.js',
  '/js/ui.js',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(async (cached) => {
      const isNetworkFirst = NETWORK_FIRST_PATHS.has(url.pathname);

      if (isNetworkFirst) {
        try {
          const response = await fetch(request, { cache: 'reload' });
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        } catch {
          if (cached) return cached;
          throw new Error('Network request failed and no cache is available.');
        }
      }

      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
