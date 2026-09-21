/**
 * Ajker News Service Worker
 * v2026-09-21 — Network-first for HTML/API, no cache blocking
 *
 * Note: Push handling is done by firebase-messaging-sw.js
 */

const CACHE_VERSION = "ajker-news-v2026-09-21";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

// ✅ Install: skip waiting immediately
self.addEventListener("install", event => {
  console.log("[SW] Installing v2026-09-21...");
  self.skipWaiting();
});

// ✅ Activate: delete ALL old caches, then claim clients
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

// ✅ Fetch strategy
self.addEventListener("fetch", event => {
  const request = event.request;

  // Only handle GET
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Skip non-HTTP
  if (!url.protocol.startsWith("http")) return;

  // Skip cross-origin (except gstatic for Firebase)
  if (url.origin !== self.location.origin && !url.hostname.includes("gstatic")) {
    return;
  }

  // ✅ API, go links, and navigation: NETWORK-FIRST, no cache
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/go/") ||
    request.mode === "navigate" ||
    request.destination === "document"
  ) {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .catch(() => {
          // Offline fallback for navigation only
          if (request.mode === "navigate" || request.destination === "document") {
            return caches.match("/");
          }
          return new Response("Offline", { status: 503 });
        })
    );
    return;
  }

  // ✅ Static assets (logo, manifest): cache-first
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

// ✅ Allow client to force skip waiting
self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
