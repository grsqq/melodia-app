'use strict';
// Keeps the app itself on the phone so it opens without internet. The music lives in IndexedDB.
// Bump VERSION whenever any of the files below change, so phones pick up the update.
const VERSION = 'melodia-5';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'icons.js', 'eq.js', 'jsmediatags.min.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Cached copy first (instant, offline); a fresh copy is fetched in the background for next time.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((r) => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
    return hit || (await fresh) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
  }));
});
