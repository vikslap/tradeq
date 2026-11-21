// TradeQuest service worker: makes the site installable as an app and lets the
// app shell open even on a flaky connection. Your journal data (/api/*) is never
// cached — it always comes live from the server.
const CACHE = 'tq-shell-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/index.html', '/styles.css', '/js/main.js', '/manifest.json', '/icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('tq-shell')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// App files: network first (so updates show at once), cached copy if offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html'))),
  );
});
