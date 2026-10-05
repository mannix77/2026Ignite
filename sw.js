// Offline support: conference Wi-Fi is unreliable.
// - The app shell is installed atomically per version and served from that version only,
//   so modules from two deploys never mix. CI stamps VERSION with a hash of the shell files.
// - Catalog data is network-first with a short timeout, falling back to the last good copy
//   (also on HTTP errors). It lives in its own cache that survives app updates.
const VERSION = 'ignite26-dev';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = 'data-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'assets/css/app.css',
  'assets/js/app.js', 'assets/js/data.js', 'assets/js/live.js', 'assets/js/planner.js', 'assets/js/store.js',
  'assets/js/time.js', 'assets/js/ui.js', 'assets/js/venue.js',
  'assets/icons/icon.svg', 'assets/icons/icon-180.png', 'assets/icons/icon-512.png',
];
const DATA = ['data/sessions.json', 'data/changes.json', 'data/meta.json'];
const DATA_TIMEOUT_MS = 3500;

const dataKey = url => { const u = new URL(url, self.location); return u.origin + u.pathname; };

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL.map(p => new Request(p, { cache: 'reload' })));
    const data = await caches.open(DATA_CACHE);
    await Promise.all(DATA.map(async p => {
      try {
        const res = await fetch(p, { cache: 'no-cache' });
        if (res.ok) await data.put(dataKey(p), res);
      } catch { /* offline during install: the shell still works with whatever is cached */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  if (url.pathname.includes('/data/')) {
    const { response, done } = dataFirst(req);
    e.respondWith(response);
    e.waitUntil(done); // keep the worker alive until the cache is refreshed
    return;
  }
  // Shell: this version's copy; navigations get the app page whatever the hash/query.
  e.respondWith((async () => {
    const shell = await caches.open(SHELL_CACHE);
    const hit = req.mode === 'navigate'
      ? await shell.match('index.html') || await shell.match('./')
      : await shell.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});

function dataFirst(req) {
  const key = dataKey(req.url);
  const cached = () => caches.open(DATA_CACHE).then(c => c.match(key));
  const net = fetch(req).then(async res => {
    if (res.ok) await (await caches.open(DATA_CACHE)).put(key, res.clone());
    return res;
  });
  const done = net.catch(() => {});
  const network = net.then(async res => (res.ok ? res : (await cached()) || res))
    .catch(async () => (await cached()) || Response.error());
  const timeout = new Promise(resolve => setTimeout(() => resolve(cached()), DATA_TIMEOUT_MS));
  // Whichever comes first: fresh data, or (on slow Wi-Fi) the cached copy.
  const response = Promise.race([network, timeout]).then(r => r || network);
  return { response, done };
}
