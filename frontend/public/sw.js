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
    // The backend sends `url` at the top level; `data.url` is accepted too.
    const url = (payload.data && payload.data.url) || payload.url || '/contests';
    const options = {
      body: payload.message || payload.body || 'A competitive programming contest is starting in 30 minutes.',
      icon: payload.icon || '/favicon.svg',
      badge: '/favicon.svg',
      actions: payload.actions || [],
      data: {
        url,
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
        url: data.url || '/contests',
        contestId: data.contestId,
      },
      tag: `contest-alert-${data.contestId || 'local'}`,
      renotify: true,
    };

    event.waitUntil(self.registration.showNotification(title, options));
  }
});

// Handle notification click: focus a tab already on the target, reuse a DevTrack
// tab for in-app pages, or open a new window (always the case for contest sites).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target;
  try {
    target = new URL(event.notification.data?.url || '/contests', self.location.origin);
  } catch {
    target = new URL('/contests', self.location.origin);
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const exact = windowClients.find((client) => client.url === target.href && 'focus' in client);
      if (exact) return exact.focus();
      if (target.origin === self.location.origin) {
        const appTab = windowClients.find((client) => 'focus' in client && 'navigate' in client);
        if (appTab) return appTab.focus().then((focused) => (focused || appTab).navigate(target.href));
      }
      if (clients.openWindow) {
        return clients.openWindow(target.href);
      }
    })
  );
});
