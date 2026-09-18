/**
 * Ajker News Service Worker
 * v2026-09-18-1 — Push notification fix + dynamic origin
 */

const CACHE_VERSION = "ajker-news-v2026-09-18-1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const LOGO_URL = "/logo.png";

const APP_SHELL = ["/", "/manifest.json", LOGO_URL];

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
        keys.filter(k => k.startsWith("ajker-news-") && k !== STATIC_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  const type = event.data?.type;

  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (type === "CLEAR_NOTIFICATIONS") {
    event.waitUntil(
      self.registration.getNotifications()
        .then(list => list.forEach(n => { try { n.close(); } catch (_) {} }))
        .catch(() => {})
    );
  }
});

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
      fetch(request).catch(() => caches.match("/"))
    );
    return;
  }

  if (["script", "style", "image", "font"].includes(request.destination) ||
      url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(request).then(c => c || fetch(request)));
    return;
  }

  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

/* =========================================================
 * Push Notification
 * ========================================================= */
self.addEventListener("push", event => {
  console.log("[SW] Push event received");

  let data = {
    title: "আজকের নিউজ",
    body: "নতুন খবর এসেছে!",
    url: "/",
    icon: LOGO_URL,
    badge: LOGO_URL,
    image: null,
    notificationId: ""
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
      console.log("[SW] Push data:", JSON.stringify(data).slice(0, 200));
    } catch (e) {
      try {
        const text = event.data.text();
        if (text) data.body = text;
      } catch (_) {}
    }
  }

  if (!data.notificationId) {
    data.notificationId = "notif-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  }

  const options = {
    body: data.body,
    icon: data.icon || LOGO_URL,
    badge: data.badge || LOGO_URL,
    image: data.image || undefined,
    vibrate: [200, 100, 200],
    tag: data.notificationId,
    renotify: true,
    silent: false,
    requireInteraction: false,
    timestamp: Date.now(),
    data: {
      url: data.url || "/",
      notificationId: data.notificationId,
      timestamp: Date.now()
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
      .then(() => console.log("[SW] Notification shown"))
      .catch(err => console.error("[SW] showNotification failed:", err))
  );
});

/* =========================================================
 * Notification Click
 * ========================================================= */
self.addEventListener("notificationclick", event => {
  event.notification.close();

  const notifData = event.notification.data || {};
  let targetUrl = notifData.url || "/";
  if (!targetUrl.startsWith("http")) {
    targetUrl = `${self.location.origin}${targetUrl.startsWith("/") ? targetUrl : "/" + targetUrl}`;
  }

  let newsId = notifData.notificationId || "";
  if (newsId.startsWith("news:")) newsId = newsId.slice(5);
  if (!newsId) {
    try {
      const u = new URL(targetUrl);
      newsId = u.searchParams.get("id") || u.pathname.split("/").filter(Boolean).pop() || "";
    } catch (_) {}
  }

  event.waitUntil((async () => {
    try {
      const all = await self.registration.getNotifications();
      all.forEach(n => { try { n.close(); } catch (_) {} });
    } catch (_) {}

    const windowClients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of windowClients) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        try {
          client.postMessage({
            type: "OPEN_NEWS_URL",
            url: targetUrl,
            newsId: newsId
          });
        } catch (_) {}
        try { await client.focus(); } catch (_) {}
        return;
      }
    }

    if (self.clients.openWindow) {
      try {
        await self.clients.openWindow(targetUrl);
      } catch (err) {
        console.error("[SW] openWindow failed:", err);
      }
    }
  })());
});

/* =========================================================
 * Subscription Change (dynamic origin)
 * ========================================================= */
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    try {
      const oldSub = event.oldSubscription;
      const appServerKey = oldSub?.options?.applicationServerKey;
      if (!appServerKey) {
        console.warn("[SW] No applicationServerKey; cannot renew");
        return;
      }

      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey
      });

      await fetch(`${self.location.origin}/api/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSub)
      });

      console.log("[SW] Subscription renewed");
    } catch (e) {
      console.error("[SW] pushsubscriptionchange failed:", e);
    }
  })());
});
