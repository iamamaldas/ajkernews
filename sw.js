// sw.js
// ✅ FINAL v34 — Offline Queue + FCM + Image Support + TTL Safe

const CACHE_VERSION = "ajker-news-v2026-10-08-final11";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

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
    console.log('[SW-FCM] Background message:', JSON.stringify(payload));

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

    const title = payload.data?.title || payload.notification?.title || 'Ajker News';
    const body = payload.data?.body || payload.notification?.body || 'নতুন খবর এসেছে';
    const image = payload.data?.image || payload.notification?.image || undefined;
    const url = payload.data?.url || 'https://ajkernews.in/';
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
      silent: false,
      data: { url: url }
    });
  });
}

const DB_NAME = 'ajker-news-notif-db';
const DB_VERSION = 1;
const STORE_NAME = 'pending_notifications';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePendingNotification(notif) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add(notif);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { return false; }
}

async function getPendingNotifications() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return []; }
}

async function clearPendingNotifications() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { return false; }
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch (e) { return; }
  
  const data = payload.data || payload;
  if (!data || !data.title) return;

  const notifData = {
    title: data.title || 'Ajker News',
    body: data.body || 'নতুন খবর এসেছে',
    image: data.image || null,
    url: data.url || 'https://ajkernews.in/',
    tag: data.notificationId || 'ajker-' + Date.now(),
    receivedAt: Date.now()
  };

  event.waitUntil(
    (async () => {
      await savePendingNotification(notifData);
      try {
        await self.registration.showNotification(notifData.title, {
          body: notifData.body,
          icon: '/logo.png',
          badge: '/logo.png',
          image: notifData.image || undefined,
          vibrate: [200, 100, 200],
          tag: notifData.tag,
          renotify: true,
          requireInteraction: true,
          silent: false,
          data: { url: notifData.url }
        });
        await clearPendingNotifications();
      } catch (e) {}
    })()
  );
});

async function flushPendingNotifications() {
  try {
    const pending = await getPendingNotifications();
    if (!pending || !pending.length) return;
    for (const notif of pending) {
      try {
        await self.registration.showNotification(notif.title, {
          body: notif.body,
          icon: '/logo.png',
          badge: '/logo.png',
          image: notif.image || undefined,
          vibrate: [200, 100, 200],
          tag: notif.tag,
          renotify: true,
          requireInteraction: true,
          silent: false,
          data: { url: notif.url }
        });
      } catch (e) {}
    }
    await clearPendingNotifications();
  } catch (e) {}
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let targetUrl = event.notification.data?.url || 'https://ajkernews.in/';
  if (targetUrl.startsWith('/')) targetUrl = 'https://ajkernews.in' + targetUrl;
  else if (!targetUrl.startsWith('http')) targetUrl = 'https://ajkernews.in/' + targetUrl;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith('https://ajkernews.in') && 'focus' in client) {
          return client.focus().then(() => {
            if ('navigate' in client) return client.navigate(targetUrl);
            return client;
          });
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: event.oldSubscription ? event.oldSubscription.options.applicationServerKey : undefined
        });
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        allClients.forEach((client) => client.postMessage({ type: 'REFRESH_FCM_TOKEN' }));
      } catch (e) {}
    })()
  );
});

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k.startsWith("ajker-news-") && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
      );
      await self.clients.claim();
      await flushPendingNotifications();
    })()
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!url.protocol.startsWith("http")) return;
  if (url.origin !== self.location.origin && !url.hostname.includes("gstatic")) return;

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
        if (!response || response.status !== 200 || response.type !== "basic") return response;
        const responseToCache = response.clone();
        caches.open(STATIC_CACHE).then(cache => cache.put(request, responseToCache));
        return response;
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'NETWORK_ONLINE') {
    event.waitUntil(
      (async () => {
        await flushPendingNotifications();
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        clients.forEach((client) => client.postMessage({ type: 'REFRESH_FCM_TOKEN' }));
      })()
    );
  }

  if (event.data && event.data.type === 'FLUSH_PENDING') {
    event.waitUntil(flushPendingNotifications());
  }
});
