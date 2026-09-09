const CACHE_NAME = "ajker-news-v2026-09-09-1";

const STATIC_ASSETS = [
    "/",
    "/index.html",
    "/assets/logo.png"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});


/* =========================
   FETCH
========================= */

self.addEventListener("fetch", event => {
    const request = event.request;

    if (request.method !== "GET") {
        return;
    }

    event.respondWith(
        fetch(request)
            .then(response => {
                if (
                    response &&
                    response.status === 200 &&
                    request.url.startsWith(self.location.origin)
                ) {
                    const responseClone = response.clone();

                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(request, responseClone);
                    });
                }

                return response;
            })
            .catch(() => {
                return caches.match(request)
                    .then(cached => cached || caches.match("/"));
            })
    );
});


/* =========================
   PUSH NOTIFICATION
========================= */

self.addEventListener("push", event => {
    let data = {};

    try {
        if (event.data) {
            data = event.data.json();
        }
    } catch (error) {
        try {
            data = {
                body: event.data ? event.data.text() : ""
            };
        } catch (e) {
            data = {};
        }
    }

    const title = data.title || "নতুন খবর!";

    const options = {
        body: data.body || "আজকের নতুন খবর দেখুন।",

        icon: "/assets/logo.png",

        badge: "/assets/logo.png",

        image: data.image || undefined,

        tag: data.tag || "ajker-news",

        renotify: true,

        requireInteraction: false,

        data: {
            url: data.url || "/",
            newsId: data.newsId || null
        },

        actions: [
            {
                action: "open",
                title: "খবর দেখুন"
            }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});


/* =========================
   NOTIFICATION CLICK
========================= */

self.addEventListener("notificationclick", event => {
    event.notification.close();

    const notificationData = event.notification.data || {};

    let targetUrl = notificationData.url || "/";

    if (event.action === "open") {
        targetUrl = notificationData.url || "/";
    }

    event.waitUntil(
        clients.matchAll({
            type: "window",
            includeUncontrolled: true
        }).then(clientList => {

            for (const client of clientList) {

                if ("focus" in client) {
                    try {
                        if (targetUrl) {
                            client.navigate(targetUrl);
                        }
                    } catch (error) {
                        // Ignore navigation errors.
                    }

                    return client.focus();
                }
            }

            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }

            return null;
        })
    );
});


/* =========================
   NOTIFICATION CLOSE
========================= */

self.addEventListener("notificationclose", event => {
    // Notification closed by user.
});


/* =========================
   BACKGROUND SYNC
   Recovery only
========================= */

self.addEventListener("sync", event => {

    if (event.tag !== "sync-pending-notifications") {
        return;
    }

    event.waitUntil(
        syncPendingNotifications()
    );
});


async function syncPendingNotifications() {

    try {

        const response = await fetch("/api/push-sync", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include"
        });

        if (!response.ok) {
            throw new Error(
                "Push sync failed: " + response.status
            );
        }

        return await response.text();

    } catch (error) {

        console.error(
            "Background push sync error:",
            error
        );

        throw error;
    }
}


/* =========================
   MESSAGE HANDLER
========================= */

self.addEventListener("message", event => {

    if (!event.data) {
        return;
    }

    if (event.data.type === "SKIP_WAITING") {
        self.skipWaiting();
    }

    if (event.data.type === "SYNC_PENDING_NOTIFICATIONS") {
        event.waitUntil(
            syncPendingNotifications()
        );
    }
});
