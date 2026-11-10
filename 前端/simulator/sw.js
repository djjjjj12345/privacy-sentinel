'use strict';

const PREFIX = 'ps-rehearsal-shell-';
const CACHE = `${PREFIX}1`;
const resolve = (path) => new URL(path, self.registration.scope).href;
const entry = resolve('index.html');
const assets = ['index.html', 'style.css', 'engine.js', 'app.js', 'manifest.webmanifest',
  '../icons/icon.svg', '../icons/icon-192.png', '../icons/icon-512.png'].map(resolve);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(assets)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const target = request.url === self.registration.scope ? entry : request.url;
  if (!assets.includes(target)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(target)) || fetch(request);
  })());
});
