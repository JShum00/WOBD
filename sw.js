// Service worker: caches the static app shell only. Web Serial talks to the
// USB adapter directly and never goes through fetch, so nothing here can touch
// it. Bump CACHE_VERSION to force every returning user onto fresh files.
const CACHE_VERSION = 'v54';
const CACHE_NAME = `wobd-cache-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  'index.html',
  'guide.html',
  'contact.html',
  'codes.html',
  'tested-adapters.html',
  'report.html',
  'replay.html',
  'simulator.html',
  'changelog.html',
  'manifest.webmanifest',
  'css/style.css',
  'css/print.css',
  'js/adapter-data.js',
  'js/app.js',
  'js/banner.js',
  'js/bob.js',
  'js/codes.js',
  'js/conninfo.js',
  'js/demo.js',
  'js/dom.js',
  'js/elm327.js',
  'js/gauge-picker.js',
  'js/obd.js',
  'js/pwa.js',
  'js/record-lock.js',
  'js/recorder.js',
  'js/replay-data.js',
  'js/annotations.js',
  'js/detectors.js',
  'js/session-report.js',
  'js/i18n.js',
  'js/i18n-boot.js',
  'js/units.js',
  'data/i18n/en.json',
  'data/i18n/fr.json',
  'data/i18n/de.json',
  'data/i18n/es.json',
  'data/i18n/ja.json',
  'data/i18n/zh-Hans.json',
  'data/i18n/codes.fr.json',
  'data/i18n/codes.de.json',
  'data/i18n/codes.es.json',
  'data/i18n/codes.ja.json',
  'data/i18n/codes.zh-Hans.json',
  'js/zip.js',
  'js/wobd.js',
  'js/csv-lossless.js',
  'js/flight-store.js',
  'js/backup.js',
  'js/replay-downsample.js',
  'js/replay.js',
  'js/info-tip.js',
  'js/raw-capture.js',
  'js/report.js',
  'js/site-nav.js',
  'js/serial.js',
  'js/simulator.js',
  'js/smartbauder.js',
  'js/theme.js',
  'js/traffic.js',
  'js/troubleshoot.js',
  'js/tested-adapters.js',
  'js/ui.js',
  'js/dtc.js',
  'js/vehicles.js',
  'js/version-info.js',
  'js/vin.js',
  'js/version.js',
  'js/voice.js',
  'data/codes.json',
  'data/tested-adapters.json',
  'data/generic/P0.json',
  'data/generic/P2.json',
  'data/generic/P3.json',
  'data/generic/U0.json',
  'data/generic/U3.json',
  'data/generic/B0.json',
  'data/generic/C0.json',
  'data/code-counts.json',
  // manufacturer-codes:start
  'data/manufacturer/index.json',
  'data/manufacturer/LICENSE',
  'data/manufacturer/acura.json',
  'data/manufacturer/alfa-romeo.json',
  'data/manufacturer/audi.json',
  'data/manufacturer/bmw.json',
  'data/manufacturer/chevrolet.json',
  'data/manufacturer/chrysler.json',
  'data/manufacturer/citroen.json',
  'data/manufacturer/dodge.json',
  'data/manufacturer/fiat.json',
  'data/manufacturer/ford.json',
  'data/manufacturer/honda.json',
  'data/manufacturer/hyundai.json',
  'data/manufacturer/isuzu.json',
  'data/manufacturer/jaguar.json',
  'data/manufacturer/jeep.json',
  'data/manufacturer/kia.json',
  'data/manufacturer/lamborghini.json',
  'data/manufacturer/land-rover.json',
  'data/manufacturer/lexus.json',
  'data/manufacturer/lincoln.json',
  'data/manufacturer/mazda.json',
  'data/manufacturer/mercedes-benz.json',
  'data/manufacturer/mercury.json',
  'data/manufacturer/mini.json',
  'data/manufacturer/mitsubishi.json',
  'data/manufacturer/nissan.json',
  'data/manufacturer/oldsmobile.json',
  'data/manufacturer/opel.json',
  'data/manufacturer/peugeot.json',
  'data/manufacturer/porsche.json',
  'data/manufacturer/saab.json',
  'data/manufacturer/saturn.json',
  'data/manufacturer/subaru.json',
  'data/manufacturer/suzuki.json',
  'data/manufacturer/toyota.json',
  'data/manufacturer/volkswagen.json',
  'data/manufacturer/volvo.json',
  // manufacturer-codes:end
  'data/makes.json',
  'data/models.json',
  'img/bob.png',
  'Assets/favicon.png',
  'Assets/header-logo.png',
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

  // Pretty URLs: "/" is index.html and "/guide" is guide.html. Real files that
  // aren't cached, like report PDFs, go to the network instead of the home page.
  // Trouble code pages (/codes/p0340) are fetched on demand, never the home page.
  if (url.pathname.startsWith('/codes/')) return undefined;
  const name = url.pathname.split('/').pop();
  if (name.includes('.')) return undefined;
  const page = name === '' ? 'index.html' : `${name}.html`;
  return (await cache.match(page)) ?? (await cache.match('index.html'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Static, same-origin GETs only. Everything else goes straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => (await fromCache(request)) ?? fetch(request))());
});
