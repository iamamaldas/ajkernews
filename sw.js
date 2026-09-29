// sw.js
// ✅ FINAL v22 — Consolidated Service Worker
// Handles: cache + FCM background notification + notificationclick

const CACHE_VERSION = "ajker-news-v2026-09-29-final";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

// ===== FCM Setup =====
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
    console.log('[SW-FCM] Background message received:', JSON.stringify(payload));

    // Handle silent news_published event
    if (payload.data && payload.data.type === 'news_published') {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'news_published',
            count: parseInt(payload.data.count || '0', 10),
            ids: (payload.data.ids || '').split(',').filter(Boolean)
          });
        });
      });
    }

    // Standard notification payload (fallback if Chrome doesn't auto-render)
    const title = payload.data?.title || payload.notification?.title || 'Ajker News';
    const body = payload.data?.body || payload.notification?.body || 'নতুন খবর এসেছে';
    const image = payload.data?.image || payload.notification?.image || undefined;
    const url = payload.data?.url || payload.fcmOptions?.link || 'https://ajkernews.in/';
    const tag = payload.data?.notificationId || 'ajker-' + Date.now();

    return self.registration.showNotification(title, {
      body: body,
      icon: '/logo.png',
      badge: '/logo.png',
      image: image,
      vibrate: [200, 100, 200],
      tag: tag,
      renotify: true,
      requireInteraction: true,
      data: { url: url }
    });
  });
}

// ===== Notification Click =====
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

// ===== Install / Activate =====
self.addEventListener("install", event => {
  console.log("[SW] Installing", CACHE_VERSION);
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  console.log("[SW] Activating...");
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith("ajker-news-") && k !== STATIC_CACHE)
          .map(k => {
            console.log("[SW] Deleting old cache:", k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ===== Fetch =====
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!url.protocol.startsWith("http")) return;

  if (url.origin !== self.location.origin && !url.hostname.includes("gstatic")) {
    return;
  }

  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/go/") ||
    request.mode === "navigate" ||
    request.destination === "document"
  ) {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .catch(() => {
          if (request.mode === "navigate" || request.destination === "document") {
            return caches.match("/");
          }
          return new Response("Offline", { status: 503 });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(STATIC_CACHE).then(cache => {
          cache.put(request, responseToCache);
        });
        return response;
      });
    })
  );
});

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
