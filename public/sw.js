// WPS Staff Hub Service Worker
const CACHE_NAME = 'wps-hub-v12.2.0';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Push notifications
self.addEventListener('push', event => {
  let data = { title: 'WPS Staff Hub', body: 'New notification' };
  try { data = event.data.json(); } catch(e) { data.body = event.data ? event.data.text() : 'New notification'; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'WPS Staff Hub', {
      body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      vibrate: [200, 100, 200], data
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for (const c of list) if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — network only
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request).catch(() =>
      new Response(JSON.stringify({ error: 'Offline' }), { headers: { 'Content-Type': 'application/json' } })
    ));
    return;
  }

  // Everything else — network first, cache fallback (always fresh when online)
  event.respondWith(
    fetch(event.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
      return resp;
    }).catch(() => caches.match(event.request))
  );
});
