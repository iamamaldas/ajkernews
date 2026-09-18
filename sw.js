/**
 * Ajker News Service Worker
 * v2026-09-18-2 — FCM-based
 *
 * Note: Push handling is now done by firebase-messaging-sw.js
 * This SW handles: caching + fetch strategy
 */

const CACHE_VERSION = "ajker-news-v2026-09-18-2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith("ajker-news-") && k !== STATIC_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // API and dynamic routes — network only
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/go/")) {
    event.respondWith(fetch(request));
    return;
  }

  // HTML navigation — network first
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  // Static assets — network, fallback to cache
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
