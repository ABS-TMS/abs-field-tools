// sw.js -- minimal service worker for ABS Field Tools
// This exists primarily to satisfy PWA installability requirements
// (Chrome/Android requires a registered service worker before offering
// "Add to Home Screen"). It does basic offline-shell caching of the
// app's own static files -- it does NOT cache API responses, so
// Property Scout searches and Buyer Intake data always come in fresh.

const CACHE_NAME = 'abs-field-tools-v1';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', (event) => {
  // Never intercept calls to our own Netlify Functions (Property Scout)
  // or to Supabase (Buyer Intake) -- those must always hit the network.
  if (event.request.url.includes('/.netlify/functions/') || event.request.url.includes('supabase.co')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
