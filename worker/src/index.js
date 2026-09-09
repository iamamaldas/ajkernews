/**
 * Ajker News Service Worker -- with Enhanced Background Sync
 */

const CACHE_VERSION = "ajker-news-v2026-09-09-1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/assets/logo.png"
];

// Install
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith("ajker-news-") && key !== STATIC_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Message
self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Fetch
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/go/") ||
      url.pathname === "/news") {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  if (["script", "style", "image", "font"].includes(request.destination) ||
      url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request))
    );
    return;
  }

  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ========== PUSH NOTIFICATION ==========
self.addEventListener("push", event => {
  let data = {
    title: "Ajker News",
    body: "নতুন খবর এসেছে!",
    url: "/",
    icon: "/assets/logo.png",
    badge: "/assets/logo.png",
    notificationId: Date.now().toString()
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch (e) {
      const text = event.data.text();
      if (text) data.body = text;
    }
  }

  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    vibrate: [200, 100, 200],
    tag: data.notificationId || data.url || "ajker-news",
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: {
      url: data.url || "/",
      notificationId: data.notificationId || "",
      timestamp: Date.now()
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ========== NOTIFICATION CLICK ==========
self.addEventListener("notificationclick", event => {
  event.notification.close();

  const url = event.notification.data?.url || "/";
  const fullUrl = url.startsWith("http")
    ? url
    : `https://ajkernews.in${url.startsWith("/") ? url : "/" + url}`;

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of windowClients) {
      if (client.url.includes("ajkernews.in") && "focus" in client) {
        try {
          if ("navigate" in client) await client.navigate(fullUrl);
        } catch (_) {}
        await client.focus();
        return;
      }
    }

    if (clients.openWindow) return clients.openWindow(fullUrl);
  })());
});

// ========== BACKGROUND SYNC ==========
self.addEventListener('sync', event => {
  if (event.tag === 'sync-pending-notifications') {
    event.waitUntil(syncMissedNotifications());
  }
});

async function syncMissedNotifications() {
  try {
    const registration = await self.registration;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      console.warn('No push subscription found for sync.');
      return;
    }

    const response = await fetch('https://ajkernews.ajkernews-1c0.workers.dev/api/push-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    });

    if (response.ok) {
      console.log('✅ Background sync: missed notifications delivered.');
    } else {
      console.warn('⚠️ Background sync failed with status:', response.status);
    }
  } catch (e) {
    console.error('❌ Background sync error:', e);
  }
}
