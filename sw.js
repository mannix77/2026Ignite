// Offline support: conference Wi-Fi is unreliable. App shell is cache-first;
// catalog data is network-first with the last good copy as fallback.
const VERSION = 'ignite26-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'assets/css/app.css',
  'assets/js/app.js', 'assets/js/data.js', 'assets/js/planner.js', 'assets/js/store.js',
  'assets/js/time.js', 'assets/js/ui.js', 'assets/js/venue.js', 'assets/icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  if (url.pathname.includes('/data/')) {
    const key = url.origin + url.pathname; // ignore cache-busting query
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then(r => r || Response.error())));
    return;
  }
  // Shell: serve cached, refresh in the background so the next load gets updates.
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(cached => {
    const net = fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => cached);
    return cached || net;
  }));
});
