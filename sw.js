// sw.js
// ✅ Main Service Worker — শুধু cache, install, activate, message handle করে
// FCM SW আলাদা ফাইলে handle করে (firebase-messaging-sw.js)

const CACHE_VERSION = "ajker-news-v2026-09-23-sse-fcm";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

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
