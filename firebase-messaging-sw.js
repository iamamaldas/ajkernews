/**
 * Firebase Cloud Messaging Service Worker
 * Handles background push notifications from FCM
 */

importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

// Firebase configuration (public-safe)
firebase.initializeApp({
  apiKey: "AIzaSyBdduTjoMMRUeMUnzN7sRHl70Wl0Bi9Mts",
  authDomain: "ajkernewsnotifications.firebaseapp.com",
  projectId: "ajkernewsnotifications",
  storageBucket: "ajkernewsnotifications.firebasestorage.app",
  messagingSenderId: "430988740362",
  appId: "1:430988740362:web:ccb5e3cd2eeefc82345cf3"
});

const messaging = firebase.messaging();

// Handle background messages (when app is closed or in background)
messaging.onBackgroundMessage((payload) => {
  console.log('[FCM-SW] Background message received:', JSON.stringify(payload));

  const notificationTitle = payload.notification?.title || 'আজকের নিউজ';
  const notificationBody = payload.notification?.body || 'নতুন খবর এসেছে';

  const notificationOptions = {
    body: notificationBody,
    icon: payload.notification?.icon || '/logo.png',
    badge: '/logo.png',
    image: payload.data?.image || undefined,
    vibrate: [200, 100, 200],
    tag: payload.data?.notificationId || 'ajker-news',
    renotify: true,
    data: {
      url: payload.data?.url || 'https://ajkernews.in/',
      notificationId: payload.data?.notificationId || ''
    }
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || 'https://ajkernews.in/';
  const fullUrl = targetUrl.startsWith('http') ? targetUrl : `https://ajkernews.in${targetUrl.startsWith('/') ? targetUrl : '/' + targetUrl}`;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith('https://ajkernews.in') && 'focus' in client) {
          return client.focus().then(() => client.navigate(fullUrl));
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
    })
  );
});

// Handle subscription change
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
