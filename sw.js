// sw.js
// ✅ FINAL v37 — Offline Queue + FCM + No Duplicate Notifications + Adsterra Safe

const CACHE_VERSION = "ajker-news-v2026-10-27-final14";
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

// ═══════════════════════════════════════════════════════════
// ✅ IndexedDB for pending notifications
// ═══════════════════════════════════════════════════════════
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
  } catch (e) {
    console.warn('[SW] savePendingNotification failed:', e);
    return false;
  }
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
  } catch (e) {
    console.warn('[SW] getPendingNotifications failed:', e);
    return [];
  }
}

async function deletePendingNotification(id) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════
// ✅ Show notification helper
// ═══════════════════════════════════════════════════════════
async function showNotificationSafe(notif) {
  try {
    await self.registration.showNotification(notif.title, {
      body: notif.body,
      icon: '/logo.png',
      badge: '/logo.png',
      image: notif.image || undefined,
      vibrate: [200, 100, 200],
      tag: notif.tag || 'ajker-news',
      renotify: true,
      requireInteraction: true,
      silent: false,
      data: { url: notif.url || '/' }
    });
    return true;
  } catch (e) {
    console.warn('[SW] showNotification failed:', e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// ✅ Flush pending notifications
// ═══════════════════════════════════════════════════════════
async function flushPendingNotifications() {
  try {
    const pending = await getPendingNotifications();
    if (!pending || !pending.length) return { flushed: 0, failed: 0 };

    console.log('[SW] Flushing', pending.length, 'pending notifications');

    let flushed = 0;
    let failed = 0;

    for (const notif of pending) {
      const ok = await showNotificationSafe(notif);
      if (ok) {
        await deletePendingNotification(notif.id);
        flushed++;
      } else {
        failed++;
      }
    }

    console.log('[SW] Flush complete:', flushed, 'flushed,', failed, 'failed');
    return { flushed, failed };
  } catch (e) {
    console.warn('[SW] flushPendingNotifications error:', e);
    return { flushed: 0, failed: 0 };
  }
}

// ═══════════════════════════════════════════════════════════
// ✅ FCM Background Handler — ONLY news_published type
// ⚠️ IMPORTANT: Do NOT call showNotification here.
// The 'push' event handler below handles notification display.
// This prevents DUPLICATE notifications.
// ═══════════════════════════════════════════════════════════
if (firebase.messaging.isSupported()) {
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    console.log('[SW-FCM] Background message:', JSON.stringify(payload));

    // ✅ Only handle news_published signal — notify open clients
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

    // ⚠️ For all other notifications, DO NOTHING here.
    // The 'push' event handler will save + show them.
    return;
  });
}

// ═══════════════════════════════════════════════════════════
// ✅ Push Event — Save FIRST, then show
// ═══════════════════════════════════════════════════════════
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      // 1️⃣ First flush old pending
      await flushPendingNotifications();

      if (!event.data) return;

      let payload;
      try { payload = event.data.json(); } catch (e) {
        console.warn('[SW] push json parse failed:', e);
        return;
      }

      const data = payload.data || payload;
      if (!data) return;

      // ⚠️ Skip news_published signal — no notification needed
      if (data.type === 'news_published') {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        clients.forEach((client) => {
          client.postMessage({
            type: 'news_published',
            count: parseInt(data.count || '0', 10),
            ids: (data.ids || '').split(',').filter(Boolean)
          });
        });
        return;
      }

      if (!data.title) return;

      const notifData = {
        title: data.title || 'Ajker News',
        body: data.body || 'নতুন খবর এসেছে',
        image: data.image || null,
        url: data.url || 'https://ajkernews.in/',
        tag: data.notificationId || 'ajker-news',
        receivedAt: Date.now()
      };

      // 2️⃣ Save to IndexedDB FIRST
      const saved = await savePendingNotification(notifData);
      if (!saved) {
        await showNotificationSafe(notifData);
        return;
      }

      // 3️⃣ Try to show
      const shown = await showNotificationSafe(notifData);
      if (shown) {
        const allPending = await getPendingNotifications();
        const match = allPending
          .filter(n => n.tag === notifData.tag && n.receivedAt === notifData.receivedAt)
          .sort((a, b) => b.id - a.id)[0];
        if (match) {
          await deletePendingNotification(match.id);
        }
      } else {
        console.log('[SW] Notification show failed — kept in pending queue');
      }
    })()
  );
});

// ═══════════════════════════════════════════════════════════
// ✅ Notification Click
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// ✅ Push Subscription Change
// ═══════════════════════════════════════════════════════════
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
      } catch (e) {
        console.warn('[SW] pushsubscriptionchange failed:', e);
      }
    })()
  );
});

// ═══════════════════════════════════════════════════════════
// ✅ Install / Activate
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// ✅ Fetch Handler — Adsterra-safe (external domains skipped)
// ═══════════════════════════════════════════════════════════
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!url.protocol.startsWith("http")) return;

  // ⚠️ Skip external domains (Adsterra, etc.) — let browser handle
  if (url.origin !== self.location.origin && !url.hostname.includes("gstatic")) return;

  // Network-first for API, navigation, documents
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

  // Cache-first for static assets
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

// ═══════════════════════════════════════════════════════════
// ✅ Message Handler
// ═══════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (event.data && event.data.type === 'NETWORK_ONLINE') {
    event.waitUntil(
      (async () => {
        await flushPendingNotifications();
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        clients.forEach((client) => client.postMessage({ type: 'REFRESH_FCM_TOKEN' }));
      })()
    );
    return;
  }

  if (event.data && event.data.type === 'FLUSH_PENDING') {
    event.waitUntil(
      (async () => {
        await flushPendingNotifications();
      })()
    );
    return;
  }
});
