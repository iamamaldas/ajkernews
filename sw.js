/**
 * Ajker News Service Worker
 * FINAL FIX: Notification Click without Reload + Specific News on Click
 */

const CACHE_VERSION = "ajker-news-v2026-09-11-1";
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
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
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
    requireInteraction: true,
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

// ✅ FIXED: Notification Click (No navigate, only postMessage + openModal flag)
self.addEventListener("notificationclick", event => {
  event.notification.close();
  let url = event.notification.data?.url || "/";
  
  if (!url.startsWith("http")) {
    url = `https://ajkernews.in${url.startsWith("/") ? url : "/" + url}`;
  }
  
  // ✅ openModal=true ফ্ল্যাগ যোগ করা হচ্ছে, যাতে শুধু নোটিফিকেশন থেকেই মোডাল ওপেন হয়
  const separator = url.includes("?") ? "&" : "?";
  const fullUrl = `${url}${separator}openModal=true`;

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windowClients) {
      if (client.url.includes("ajkernews.in") && "focus" in client) {
        try {
          // শুধু মেসেজ পাঠান, navigate করবেন না (এতে পেজ রিলোড হবে না)
          client.postMessage({ type: "OPEN_NEWS_URL", url: fullUrl });
        } catch (_) {}
        await client.focus();
        return; 
      }
    }
    // কোনো ট্যাব খোলা না থাকলে নতুন ট্যাব খুলুন
    if (clients.openWindow) return clients.openWindow(fullUrl);
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
