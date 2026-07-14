'use strict';

const CACHE_NAME = 'magazzino-ar-v6-2-location-model';
const VERSION = '6.2.0';
const APP_SHELL = [
  './',
  './index.html',
  `./styles.css?v=${VERSION}`,
  `./db.js?v=${VERSION}`,
  `./cloud.js?v=${VERSION}`,
  `./app.js?v=${VERSION}`,
  `./qrcode-local.js?v=${VERSION}`,
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && event.request.headers.has('Authorization')) return;
  const isNavigation = event.request.mode === 'navigate';
  const isCoreAsset = sameOrigin && /\.(?:html|css|js|webmanifest)$/i.test(url.pathname);

  if (isNavigation || isCoreAsset) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(match => match || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response && (response.ok || response.type === 'opaque')) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});
