// Service worker: caches the static app shell only. Web Serial talks to the
// USB adapter directly and never goes through fetch, so nothing here can touch
// it. Bump CACHE_VERSION to force every returning user onto fresh files.
const CACHE_VERSION = 'v8';
const CACHE_NAME = `wobd-cache-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  'index.html',
  'guide.html',
  'codes.html',
  'manifest.webmanifest',
  'css/style.css',
  'css/print.css',
  'js/app.js',
  'js/bob.js',
  'js/codes.js',
  'js/demo.js',
  'js/dom.js',
  'js/elm327.js',
  'js/obd.js',
  'js/pwa.js',
  'js/serial.js',
  'js/smartbauder.js',
  'js/theme.js',
  'js/ui.js',
  'js/voice.js',
  'data/codes.json',
  'data/generic/P0.json',
  'data/generic/P2.json',
  'data/generic/P3.json',
  'data/generic/U0.json',
  'data/generic/U3.json',
  'data/generic/B0.json',
  'data/generic/C0.json',
  'data/makes.json',
  'data/models.json',
  'img/bob.png',
  'img/icons/icon-192.png',
  'img/icons/icon-512.png',
  'img/icons/icon-maskable-512.png',
  'img/icons/apple-touch-icon.png',
];

// Hosts that redirect (e.g. /index.html to /) would otherwise cache a redirected
// response, which browsers refuse to serve to a navigation.
async function cleanResponse(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async (path) => {
      const res = await fetch(new Request(path, { cache: 'reload' }));
      if (!res.ok) throw new Error(`Couldn't cache ${path} (${res.status})`);
      await cache.put(path, await cleanResponse(res));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('wobd-cache-') && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function fromCache(request) {
  const cache = await caches.open(CACHE_NAME);
  const url = new URL(request.url);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit || request.mode !== 'navigate') return hit;

  // Pretty URLs: "/" is index.html and "/guide" is guide.html.
  const page = url.pathname.endsWith('/') ? 'index.html' : `${url.pathname.split('/').pop()}.html`;
  return (await cache.match(page)) ?? (await cache.match('index.html'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Static, same-origin GETs only. Everything else goes straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => (await fromCache(request)) ?? fetch(request))());
});
