/* Ajker News Service Worker
 * Automatic old-cache cleanup + fast static assets + fresh HTML/API.
 */

const CACHE_VERSION = "ajker-news-v2026-09-05-3";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const OFFLINE_CACHE = `${CACHE_VERSION}-offline`;

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/assets/logo.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key =>
            key.startsWith("ajker-news-") &&
            key !== STATIC_CACHE &&
            key !== OFFLINE_CACHE
          )
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

async function networkFirst(request, fallbackToCache = true) {
  try {
    const response = await fetch(request);

    if (response && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }

    return response;
  } catch (error) {
    if (fallbackToCache) {
      const cached = await caches.match(request);
      if (cached) return cached;
    }

    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);

  if (cached) return cached;

  const response = await fetch(request);

  if (response && response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone()).catch(() => {});
  }

  return response;
}

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API/news data: never serve stale service-worker cache.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Share/OG pages must always reach Cloudflare Worker.
  if (
    url.pathname.startsWith("/go/") ||
    url.pathname === "/news"
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // HTML: network first, cache only as offline fallback.
  if (
    request.mode === "navigate" ||
    request.destination === "document"
  ) {
    event.respondWith(networkFirst(request, true));
    return;
  }

  // Static files: cache first for faster loading.
  if (
    ["script", "style", "image", "font"].includes(request.destination) ||
    url.pathname.startsWith("/assets/")
  ) {
    event.respondWith(
      cacheFirst(request).catch(() => caches.match("/"))
    );
    return;
  }

  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
