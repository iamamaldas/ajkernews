/* Ajker News Service Worker – with Push Support */

const CACHE_VERSION = "ajker-news-v2026-09-07-1";
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
        keys
          .filter(key => key.startsWith("ajker-news-") && key !== STATIC_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Message (for skip waiting)
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

  // API calls: network only
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Share/OG pages: network only
  if (url.pathname.startsWith("/go/") || url.pathname === "/news") {
    event.respondWith(fetch(request));
    return;
  }

  // HTML: network first, fallback to cache
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // Static assets: cache first
  if (["script", "style", "image", "font"].includes(request.destination) ||
      url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request))
    );
    return;
  }

  // Default: network, fallback cache
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
    badge: "/assets/logo.png"
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
    data: {
      url: data.url || "/"
    }
    // No extra actions – only the notification itself
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ========== NOTIFICATION CLICK ==========
self.addEventListener("notificationclick", event => {
  event.notification.close();

  const url = event.notification.data?.url || "/";
  const fullUrl = url.startsWith("http") ? url : `https://ajkernews.in${url.startsWith("/") ? url : "/" + url}`;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(windowClients => {
        for (const client of windowClients) {
          if (client.url.includes("ajkernews.in") && "focus" in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(fullUrl);
        }
      })
  );
});
