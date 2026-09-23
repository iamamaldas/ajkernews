/**
 * Firebase Cloud Messaging Service Worker
 * v5 — Silent data-only push + notification click
 */

importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBdduTjoMMRUeMUnzN7sRHl70Wl0Bi9Mts",
  authDomain: "ajkernewsnotifications.firebaseapp.com",
  projectId: "ajkernewsnotifications",
  storageBucket: "ajkernewsnotifications.firebasestorage.app",
  messagingSenderId: "430988740362",
  appId: "1:430988740362:web:ccb5e3cd2eeefc82345cf3"
});

if (firebase.messaging.isSupported()) {
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    console.log('[FCM-SW] Background message:', JSON.stringify(payload));

    // ✅ Silent data-only push → notify all open tabs
    if (payload.data && payload.data.type === 'news_published') {
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'news_published',
            count: parseInt(payload.data.count || '0', 10),
            ids: (payload.data.ids || '').split(',').filter(Boolean)
          });
        });
      });
      return; // Don't show visual notification
    }

    // Regular notification
    const notificationTitle = payload.notification?.title
      || payload.data?.title
      || 'আজকের নিউজ';
    const notificationBody = payload.notification?.body
      || payload.data?.body
      || 'নতুন খবর এসেছে';

    const notificationOptions = {
      body: notificationBody,
      icon: payload.notification?.icon || payload.data?.icon || 'https://ajkernews.in/logo.png',
      badge: 'https://ajkernews.in/logo.png',
      image: payload.data?.image || payload.notification?.image || undefined,
      vibrate: [200, 100, 200],
      tag: payload.data?.notificationId || 'ajker-news',
      renotify: true,
      requireInteraction: false,
      data: {
        url: payload.data?.url || payload.fcmOptions?.link || 'https://ajkernews.in/',
        notificationId: payload.data?.notificationId || ''
      }
    };

    self.registration.showNotification(notificationTitle, notificationOptions)
      .then(() => console.log('[FCM-SW] ✅ Notification shown'))
      .catch((err) => console.error('[FCM-SW] ❌ showNotification failed:', err));
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || 'https://ajkernews.in/';
  const fullUrl = targetUrl.startsWith('http')
    ? targetUrl
    : `https://ajkernews.in${targetUrl.startsWith('/') ? targetUrl : '/' + targetUrl}`;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith('https://ajkernews.in') && 'focus' in client) {
          return client.focus().then(() => {
            if ('navigate' in client) return client.navigate(fullUrl);
            return client;
          });
        }
      }
      if (clients.openWindow) return clients.openWindow(fullUrl);
    })
  );
});
