// firebase-messaging-sw.js
// ✅ FINAL: Manual notification display

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
    console.log('[FCM-SW] Message:', JSON.stringify(payload));

    // Silent update — notification দেখাবে না
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

    // Notification Display
    const title = payload.notification?.title
      || payload.data?.title
      || 'Ajker News';
    const body = payload.notification?.body
      || payload.data?.body
      || 'নতুন খবর এসেছে';
    const image = payload.notification?.image
      || payload.data?.image
      || undefined;

    return self.registration.showNotification(title, {
      body: body,
      icon: '/logo.png',
      badge: '/logo.png',
      image: image,
      vibrate: [200, 100, 200],
      tag: payload.data?.notificationId || 'ajker-news',
      renotify: true,
      data: {
        url: payload.data?.url || 'https://ajkernews.in/',
        notificationId: payload.data?.notificationId || ''
      }
    });
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
