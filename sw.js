/* CROSSOVER service worker.
   Its only jobs are to make the app installable and to let the shell open
   offline. It deliberately never caches Wikidata responses — squad data
   changes and a stale answer would be worse than an honest error. */

const VERSION = 'crossover-v1';
const SHELL   = `shell-${VERSION}`;
const FONTS   = `fonts-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll is all-or-nothing; add individually so one 404 can't break install
    await Promise.all(SHELL_FILES.map(f => cache.add(f).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, FONTS]);
    await Promise.all((await caches.keys()).map(k => keep.has(k) ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

const isFont = url =>
  url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google Fonts: cache-first. They never change and the design leans on them.
  if (isFont(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(FONTS);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
        return res;
      } catch {
        return hit || Response.error();
      }
    })());
    return;
  }

  // Wikidata, Wikipedia, Commons and everything else cross-origin: straight to
  // the network, untouched. No respondWith means the browser handles it.
  if (url.origin !== self.location.origin) return;

  // Page loads: network first so a deploy lands immediately, cache as backup.
  if (request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(request);
        (await caches.open(SHELL)).put('./index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('./index.html')) ||
               (await caches.match('./')) ||
               new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Same-origin assets: serve from cache at once, refresh in the background.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(request);
    const net = fetch(request).then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
