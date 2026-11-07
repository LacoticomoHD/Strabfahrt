// Service Worker: macht die App installierbar und offline startfaehig.
// Strategie: Netz zuerst (immer aktuell), bei Ausfall der Zwischenspeicher.
// Fremde Server (Kartenkacheln) und die Server-API werden nicht angefasst.

const VERSION = '1794041761056';
const CACHE = `strab-${VERSION}`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('strab-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match(new URL('./', self.registration.scope).href);
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
