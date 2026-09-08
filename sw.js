/* =========================================================
   AJKER NEWS SERVICE WORKER
   Push notification + missed-notification deduplication
   ========================================================= */

const CACHE_NAME = 'ajker-news-push-seen-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

async function hasSeen(notificationId) {
  if (!notificationId) return false;
  const cache = await caches.open(CACHE_NAME);
  const request = new Request('/__ajker_push_seen__/' + encodeURIComponent(notificationId));
  const response = await cache.match(request);
  return !!response;
}

async function markSeen(notificationId) {
  if (!notificationId) return;
  const cache = await caches.open(CACHE_NAME);
  const request = new Request('/__ajker_push_seen__/' + encodeURIComponent(notificationId));
  await cache.put(request, new Response('1', { headers: { 'content-type': 'text/plain' } }));
}

async function acknowledgePush(data) {
  if (!data?.ackUrl || !data?.notificationId) return;
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (!subscription) return;
    await fetch(data.ackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        notificationId: data.notificationId
      })
    });
  } catch (error) {
    console.warn('Push acknowledgement failed:', error);
  }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch (error) {
      data = { title: '📰 নতুন খবর!', body: event.data?.text() || '' };
    }

    const alreadySeen = await hasSeen(data.notificationId);
    if (alreadySeen) {
      await acknowledgePush(data);
      return;
    }

    await markSeen(data.notificationId);

    const title = data.title || '📰 নতুন খবর!';
    const options = {
      body: data.body || 'আজকের গুরুত্বপূর্ণ খবর দেখুন।',
      icon: data.icon || '/assets/logo.png',
      badge: data.badge || '/assets/logo.png',
      data: {
        url: data.url || 'https://ajkernews.in/',
        notificationId: data.notificationId || ''
      },
      tag: data.notificationId || 'ajker-news',
      renotify: false
    };

    await self.registration.showNotification(title, options);
    await acknowledgePush(data);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || 'https://ajkernews.in/';
  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if ('focus' in client) {
        try {
          await client.navigate(targetUrl);
        } catch (_) {}
        return client.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
