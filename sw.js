// Offline support: conference Wi-Fi is unreliable.
// - The app shell is installed atomically per version and served from that version only,
//   so modules from two deploys never mix. CI stamps VERSION with a hash of the shell files.
// - Catalog data is network-first with a short timeout, falling back to the last good copy
//   (also on HTTP errors). It lives in its own cache that survives app updates. When the
//   timeout served a cached copy and the fresh one lands later, open pages are told.
const VERSION = 'ignite26-dev';
// Copies of the app for colleagues live in sub-folders (/gino/) of this worker's scope, each
// with its own worker. Caches are named per scope so workers never delete each other's.
const SCOPE = new URL(self.registration.scope).pathname;
const SHELL_PREFIX = `shell:${SCOPE}:`;
const SHELL_CACHE = `${SHELL_PREFIX}${VERSION}`;
// This copy's own files; anything else under the scope (another copy's folder) is left to
// the network so that copy's page, storage and worker are never served by this one.
const OWN = /^(?:$|index\.html$|manifest\.webmanifest$|sw\.js$|assets\/|data\/|tests\/fixtures\/)/;
const DATA_CACHE = 'data-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'assets/css/app.css',
  'assets/js/app.js', 'assets/js/conferences.js', 'assets/js/data.js', 'assets/js/instance.js', 'assets/js/live.js', 'assets/js/planner.js', 'assets/js/profile.js', 'assets/js/health.js',
  'assets/js/store.js', 'assets/js/suggest.js', 'assets/js/time.js', 'assets/js/ui.js', 'assets/js/venue.js',
  'assets/icons/icon.svg', 'assets/icons/icon-180.png', 'assets/icons/icon-512.png',
];
const DATA = ['data/ignite2026/sessions.json', 'data/ignite2026/changes.json', 'data/ignite2026/meta.json', 'data/ignite2026/favorites.json', 'data/ignite2026/profile.json',
  'data/gartner2026/sessions.json', 'data/gartner2026/changes.json', 'data/gartner2026/meta.json', 'data/gartner2026/favorites.json', 'data/gartner2026/profile.json',
  'data/reinvent2026/sessions.json', 'data/reinvent2026/changes.json', 'data/reinvent2026/meta.json', 'data/reinvent2026/profile.json'];
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
    // Older builds named caches 'shell-<version>'; those are this scope's too.
    .then(keys => Promise.all(keys.filter(k => (k.startsWith(SHELL_PREFIX) || k.startsWith('shell-')) && k !== SHELL_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  if (!url.pathname.startsWith(SCOPE) || !OWN.test(url.pathname.slice(SCOPE.length))) return;

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

function notifyClients(path) {
  return self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(c => c.postMessage({ type: 'data-updated', path })));
}

function dataFirst(req) {
  const key = dataKey(req.url);
  const cached = () => caches.open(DATA_CACHE).then(c => c.match(key));
  let servedCache = false;
  let saved = Promise.resolve();
  const net = fetch(req).then(res => {
    if (res.ok) {
      const copy = res.clone();
      // Best effort: a full cache (storage quota) must not hide fresh data from the app.
      saved = caches.open(DATA_CACHE).then(c => c.put(key, copy)).then(() => { if (servedCache) return notifyClients(key); }).catch(() => {});
    }
    return res;
  });
  const done = net.then(() => saved, () => {});
  const network = net.then(async res => (res.ok ? res : (await cached()) || res))
    .catch(async () => (await cached()) || Response.error());
  const timeout = new Promise(resolve => setTimeout(async () => {
    const c = await cached();
    if (c) servedCache = true;
    resolve(c);
  }, DATA_TIMEOUT_MS));
  // Whichever comes first: fresh data, or (on slow Wi-Fi) the cached copy.
  const response = Promise.race([network, timeout]).then(r => r || network);
  return { response, done };
}
