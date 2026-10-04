/* The build and development server replace this marker with the asset revision. */
const REVISION = '__GROOVE_REVISION__';
const PREFIX = `groovegoblin:${self.registration.scope}:`;
const CACHE = `${PREFIX}${REVISION}`;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(new URL('offline-assets.json', self.registration.scope), { cache: 'no-store' });
    if (!response.ok) throw new Error('Não foi possível obter a lista de recursos offline.');
    const manifest = await response.json();
    if (manifest.version !== REVISION || !Array.isArray(manifest.files)) throw new Error('A versão mudou durante a instalação. Tente novamente.');
    const urls = manifest.files.map(file => {
      const url = new URL(file, self.registration.scope);
      if (!url.href.startsWith(self.registration.scope) || url.origin !== self.location.origin) throw new Error('Recurso offline fora da aplicação.');
      return url.href;
    });
    const cache = await caches.open(CACHE);
    try {
      // addAll is atomic: an interrupted download never replaces a working version.
      await cache.addAll(urls.map(url => new Request(url, { cache: 'reload' })));
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  // Updates always bypass this cache; imported media and blob URLs never enter it.
  if (url.pathname.endsWith('/offline-assets.json') || url.pathname.endsWith('/sw.js')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match(new URL('index.html', self.registration.scope))) || fetch(request);
    return fetch(request);
  })());
});
