// firebase-messaging-sw.js
// ✅ FINAL v3: Background delivery + duplicate prevention

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
    console.log('[FCM-SW] Background message received:', JSON.stringify(payload));

    // ✅ Silent update (news_published event) — শুধু ক্লায়েন্টে মেসেজ পাঠায়, নোটিফিকেশন দেখায় না
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

    // ✅ FCM নিজেই notification payload থেকে নোটিফিকেশন দেখাবে
    // তাই SW থেকে আবার showNotification করলে ডুপ্লিকেট হবে
    if (payload.notification) {
      console.log('[FCM-SW] Notification payload present — FCM auto-displays');
      return;
    }

    // ✅ Fallback: data-only payload হলে ম্যানুয়ালি নোটিফিকেশন দেখাই
    const notificationTitle = payload.data?.title || 'আজকের নিউজ';
    const notificationBody = payload.data?.body || 'নতুন খবর এসেছে';

    const notificationOptions = {
      body: notificationBody,
      icon: payload.data?.icon || 'https://ajkernews.in/logo.png',
      badge: 'https://ajkernews.in/logo.png',
      image: payload.data?.image || undefined,
      vibrate: [200, 100, 200],
      tag: payload.data?.notificationId || 'ajker-news',
      renotify: true,
      requireInteraction: true,
      data: {
        url: payload.data?.url || 'https://ajkernews.in/',
        notificationId: payload.data?.notificationId || ''
      }
    };

    self.registration.showNotification(notificationTitle, notificationOptions)
      .then(() => console.log('[FCM-SW] ✅ Fallback notification shown'))
      .catch((err) => console.error('[FCM-SW] ❌ showNotification failed:', err));
  });
}

// =========================================================
// Notification click handling
// =========================================================
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
