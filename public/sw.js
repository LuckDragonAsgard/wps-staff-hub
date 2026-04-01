// WPS Staff Hub Service Worker
const CACHE_NAME = 'wps-hub-v10.0.0';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Push notification handler
self.addEventListener('push', event => {
  let data = { title: 'WPS Staff Hub', body: 'New notification' };
  try { data = event.data.json(); } catch(e) { data.body = event.data ? event.data.text() : 'New notification'; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'WPS Staff Hub', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [200, 100, 200],
      data: data
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

// Notify all open tabs to reload when this SW activates
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — network only, no cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // HTML and SW — network first, fall back to cache (ensures updates load immediately)
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Other static assets (icons, manifest) — cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      return resp;
    }))
  );
});
