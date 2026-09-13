// WindowCalc Alpha 9.4e — Service Worker
// Cache-first for static assets only. Never caches API responses.

const CACHE_NAME = 'windowcalc-alpha94e-static';
const STATIC_ASSETS = [
  '/',
  '/static/app.js',
  '/static/style.css',
  '/static/index.html',
  '/static/icon-192.png',
  '/static/icon-512.png',
  // Self-hosted fonts (Alpha 9.4e) — cached so PWA works fully offline
  '/static/fonts/DMSans-Regular.woff2',
  '/static/fonts/DMSans-Italic.woff2',
  '/static/fonts/DMSans-Medium.woff2',
  '/static/fonts/DMSans-SemiBold.woff2',
  '/static/fonts/DMSans-Bold.woff2',
  '/static/fonts/JetBrainsMono-Regular.woff2',
  '/static/fonts/JetBrainsMono-Medium.woff2',
  '/static/fonts/JetBrainsMono-SemiBold.woff2',
  '/static/fonts/JetBrainsMono-Bold.woff2',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Some assets failed to cache during install:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;
  // Never cache API calls, auth, or webhooks
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Only cache successful same-origin responses
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests — serve the app shell
        if (event.request.mode === 'navigate') {
          return caches.match('/static/index.html');
        }
      });
    })
  );
});
