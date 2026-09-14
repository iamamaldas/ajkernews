/**
 * Ajker News Service Worker
 * v2026-09-13-2 — Smart notification click + tray clear
 */

const CACHE_VERSION = "ajker-news-v2026-09-13-2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const LOGO_URL = "/logo.png";

const APP_SHELL = ["/", "/index.html", "/manifest.json", LOGO_URL];

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
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  if (["script", "style", "image", "font"].includes(request.destination) ||
      url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(request).then(c => c || fetch(request)));
    return;
  }

  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

self.addEventListener("push", event => {
  let data = {
    title: "আজকের নিউজ",
    body: "নতুন খবর এসেছে!",
    url: "/",
    icon: LOGO_URL,
    badge: LOGO_URL,
    notificationId: Date.now().toString()
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch (e) {
      try {
        const text = event.data.text();
        if (text) data.body = text;
      } catch (_) {}
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || LOGO_URL,
    badge: data.badge || LOGO_URL,
    vibrate: [200, 100, 200],
    tag: data.notificationId || data.url || "ajker-news",
    renotify: true,
    silent: false,
    requireInteraction: false,  // ✅ changed to false for better delivery
    priority: 2,
    timestamp: Date.now(),
    data: {
      url: data.url || "/",
      notificationId: data.notificationId || "",
      timestamp: Date.now()
    }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const notifData = event.notification.data || {};
  let targetUrl = notifData.url || "/";
  if (!targetUrl.startsWith("http")) {
    targetUrl = `https://ajkernews.in${targetUrl.startsWith("/") ? targetUrl : "/" + targetUrl}`;
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
      await self.clients.openWindow(targetUrl);
    }
  })());
});

self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    try {
      const oldSub = event.oldSubscription;
      const appServerKey = oldSub?.options?.applicationServerKey;
      if (!appServerKey) {
        console.warn("No applicationServerKey; cannot renew");
        return;
      }

      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey
      });

      await fetch("https://ajkernews.ajkernews-1c0.workers.dev/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSub)
      });

      console.log("Subscription renewed");
    } catch (e) {
      console.error("pushsubscriptionchange failed:", e);
    }
  })());
});

self.addEventListener("sync", event => {
  if (event.tag === "sync-pending-notifications") {
    event.waitUntil(syncMissedNotifications());
  }
});

async function syncMissedNotifications() {
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (!subscription) {
      console.warn("No push subscription found for sync.");
      return;
    }

    const response = await fetch("https://ajkernews.ajkernews-1c0.workers.dev/api/push-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription)
    });

    if (response.ok) {
      console.log("Background sync: missed notifications delivered.");
    } else {
      console.warn("Background sync failed:", response.status);
    }
  } catch (e) {
    console.error("Background sync error:", e);
  }
}
