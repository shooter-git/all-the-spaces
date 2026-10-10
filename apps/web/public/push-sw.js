// Push notifications, added to the app's service worker (vite.config.ts, workbox.importScripts).
// A notification only carries its title, a line of text and where it leads in the app.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not ours: show nothing unusual.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'All the Spaces', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      data: { url: typeof data.url === 'string' ? data.url : '/' },
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only ever somewhere in the app itself.
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return open.navigate(url);
      }
      return self.clients.openWindow(url);
    })(),
  );
});
