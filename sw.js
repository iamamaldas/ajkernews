/**
 * Ajker News Service Worker
 * v2026-09-19 — Caching + Fetch strategy
 *
 * Note: Push handling is done by firebase-messaging-sw.js
 */

const CACHE_VERSION = "ajker-news-v2026-09-19";
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

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/go/")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
