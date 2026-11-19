// frontend/public/sw.js — Service Worker for offline contest alerts & notifications

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle incoming Web Push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const payload = event.data.json();
    const title = payload.title || 'Contest Starting Soon!';
    const options = {
      body: payload.message || payload.body || 'A competitive programming contest is starting in 30 minutes.',
      icon: payload.icon || '/favicon.svg',
      badge: '/favicon.svg',
      actions: payload.actions || [],
      data: {
        url: payload.url || '/dsa',
        contestId: payload.contestId,
      },
      tag: payload.tag || `contest-alert-${payload.contestId || 'general'}`,
      renotify: true,
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error('[sw] Failed parsing push payload', err);
  }
});

// Handle local broadcast / scheduled messages from client windows
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'SHOW_CONTEST_NOTIFICATION') {
    const title = data.title || 'Contest Starting Soon!';
    const options = {
      body: data.message || `${data.contestName || 'Contest'} starts in 30 minutes!`,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: {
        url: data.url || '/dsa',
        contestId: data.contestId,
      },
      tag: `contest-alert-${data.contestId || 'local'}`,
      renotify: true,
    };

    event.waitUntil(self.registration.showNotification(title, options));
  }
});

// Handle notification click to navigate to contest or dashboard
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/dsa';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
