/**
 * Firebase Cloud Messaging Service Worker
 * Handles background push notifications from FCM
 * v4 — FIXED onBackgroundMessage (no Promise return)
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

  // ✅ FIXED: Promise return না করে .then/.catch দিয়ে handle
  messaging.onBackgroundMessage((payload) => {
    console.log('[FCM-SW] Background message received:', JSON.stringify(payload));

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

    // ✅ FIX: Promise return না করে chain করুন
    self.registration.showNotification(notificationTitle, notificationOptions)
      .then(() => console.log('[FCM-SW] ✅ Notification shown'))
      .catch((err) => console.error('[FCM-SW] ❌ showNotification failed:', err));

    // ✅ কিছু return করবেন না
  });

  messaging.onMessage((payload) => {
    console.log('[FCM-SW] Foreground message:', JSON.stringify(payload));
  });
} else {
  console.warn('[FCM-SW] Firebase Messaging is not supported in this browser.');
}

// ✅ Notification click handler
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
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
    })
  );
});

// ✅ Push subscription change handler
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager.getSubscription().then((subscription) => {
      if (!subscription) return;
      return fetch('https://ajkernews.in/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: subscription.endpoint })
      });
    })
  );
});
