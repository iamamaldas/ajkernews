// firebase-messaging-sw.js
// ✅ v8: data-only payload + improved click handler + breaking news support

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
    console.log('[FCM-SW] Received:', JSON.stringify(payload));

    // Silent update for news_published events
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
      return;
    }

    // ✅ data-only priority (our index.js sends data-only payload)
    const d = payload.data || {};
    const n = payload.notification || {};

    const title = d.title || n.title || 'আজকের নিউজ';
    const body = d.body || n.body || 'নতুন খবর এসেছে';
    const image = d.image || n.image || '';
    const url = d.url || payload.fcmOptions?.link || 'https://ajkernews.in/';
    const notificationId = d.notificationId || 'ajker-news';
    const isBreaking = d.isBreaking === '1';

    const notificationOptions = {
      body: body,
      icon: 'https://ajkernews.in/logo.png',
      badge: 'https://ajkernews.in/logo.png',
      image: image || undefined,
      vibrate: isBreaking ? [300, 100, 300, 100, 300] : [200, 100],
      tag: notificationId,
      renotify: true,
      requireInteraction: isBreaking, // breaking news এ persistent
      silent: false,
      data: {
        url: url,
        notificationId: notificationId,
        isBreaking: isBreaking
      }
    };

    self.registration.showNotification(title, notificationOptions)
      .then(() => console.log('[FCM-SW] ✅ Notification shown:', title))
      .catch((err) => console.error('[FCM-SW] ❌ showNotification failed:', err));
  });
}

// =========================================================
// NOTIFICATION CLICK HANDLER
// =========================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = data.url || 'https://ajkernews.in/';

  // Ensure absolute URL
  let fullUrl;
  if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
    fullUrl = targetUrl;
  } else if (targetUrl.startsWith('/')) {
    fullUrl = `https://ajkernews.in${targetUrl}`;
  } else {
    fullUrl = `https://ajkernews.in/${targetUrl}`;
  }

  console.log('[FCM-SW] Click → opening:', fullUrl);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Try to find existing tab on our origin
      for (const client of windowClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === 'https://ajkernews.in' && 'focus' in client) {
            return client.focus().then(() => {
              if ('navigate' in client) {
                return client.navigate(fullUrl);
              }
              return client;
            });
          }
        } catch (e) {
          // Skip invalid URLs
        }
      }

      // No existing tab — open new
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
    }).catch((err) => {
      console.error('[FCM-SW] Click handler error:', err);
      // Fallback: just open the URL
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
    })
  );
});
