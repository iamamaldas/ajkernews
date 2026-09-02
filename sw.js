// sw.js – Ajker News (ajkernews.in) Service Worker with Push Notifications
const CACHE = 'ajkernews-cache-v2';
const ASSETS = ['/', '/index.html', '/assets/logo.png', '/manifest.json'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(response => response || fetch(event.request).catch(() => {
            if (event.request.mode === 'navigate') return caches.match('/');
            return new Response('Offline', { status: 503 });
        }))
    );
});

// ====== PUSH NOTIFICATION ======
self.addEventListener('push', event => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'Ajker News - নতুন খবর';
    const options = {
        body: data.body || 'আমাদের ওয়েবসাইটে নতুন খবর প্রকাশিত হয়েছে।',
        icon: '/assets/logo.png',
        badge: '/assets/logo.png',
        data: {
            url: data.url || '/'
        },
        requireInteraction: true
    };
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url || '/')
    );
});