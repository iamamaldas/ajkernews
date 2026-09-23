/**
 * Ajker News Service Worker
 * v2026-09-23 — SSE + FCM Silent Push + Notification Handler
 */

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

  // ✅ Never cache SSE stream / API / navigation
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

/* =========================================================
 * PUSH EVENT HANDLER — FCM fallback
 * Handles both regular notifications and silent data-only
 * ========================================================= */

self.addEventListener("push", (event) => {
  console.log("[SW] Push event received");

  let payload = {};
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    console.error("[SW] Failed to parse push payload:", e);
    try {
      payload = { notification: { title: "আজকের নিউজ", body: event.data.text() } };
    } catch (e2) {
      payload = { notification: { title: "আজকের নিউজ", body: "নতুন খবর এসেছে" } };
    }
  }

  console.log("[SW] Push payload:", JSON.stringify(payload));

  // ✅ Silent data-only push (new news published) → notify all open tabs
  if (payload.data && payload.data.type === "news_published") {
    const count = parseInt(payload.data.count || "0", 10);
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: "news_published",
            count: count,
            ids: (payload.data.ids || "").split(",").filter(Boolean)
          });
        });
      })
    );
    // ✅ Don't show visual notification for silent updates
    return;
  }

  // Regular notification display
  const title = payload.notification?.title || payload.data?.title || "আজকের নিউজ";
  const body = payload.notification?.body || payload.data?.body || "নতুন খবর এসেছে";
  const url = payload.data?.url || payload.fcmOptions?.link || "https://ajkernews.in/";
  const image = payload.data?.image || payload.notification?.image || undefined;
  const icon = payload.notification?.icon || payload.data?.icon || "https://ajkernews.in/logo.png";

  const options = {
    body: body,
    icon: icon,
    badge: "https://ajkernews.in/logo.png",
    image: image,
    vibrate: [200, 100, 200],
    tag: payload.data?.notificationId || "ajker-news",
    renotify: true,
    requireInteraction: false,
    data: {
      url: url,
      notificationId: payload.data?.notificationId || ""
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
      .then(() => console.log("[SW] ✅ Notification shown via root SW"))
      .catch((err) => console.error("[SW] ❌ showNotification failed:", err))
  );
});

/* =========================================================
 * NOTIFICATION CLICK HANDLER
 * ========================================================= */

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "https://ajkernews.in/";
  const fullUrl = targetUrl.startsWith("http")
    ? targetUrl
    : `https://ajkernews.in${targetUrl.startsWith("/") ? targetUrl : "/" + targetUrl}`;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith("https://ajkernews.in") && "focus" in client) {
          return client.focus().then(() => {
            if ("navigate" in client) return client.navigate(fullUrl);
            return client;
          });
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
    })
  );
});
