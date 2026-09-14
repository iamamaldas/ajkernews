/*
 * Cloudflare Cache API helper
 */

const NEWS_API_TTL = 120;
const ARTICLE_TTL = 600;

export function getCache() {
  return caches.default;
}

export function createCacheRequest(request, cacheKey) {
  const url = new URL(request.url);
  if (cacheKey) {
    url.pathname = cacheKey.pathname || url.pathname;
    url.search = cacheKey.search || "";
  }
  return new Request(url.toString(), {
    method: "GET",
    headers: request.headers
  });
}

export async function getCachedResponse(request, cacheKey = null) {
  const cache = getCache();
  const cacheRequest = cacheKey ? createCacheRequest(request, cacheKey) : request;
  const response = await cache.match(cacheRequest);
  return response || null;
}

export async function putCachedResponse(request, response, ttl, cacheKey = null) {
  if (!response || !response.ok) return response;

  const cache = getCache();
  const cacheRequest = cacheKey ? createCacheRequest(request, cacheKey) : request;

  const cachedResponse = new Response(response.body, response);
  cachedResponse.headers.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);

  await cache.put(cacheRequest, cachedResponse.clone());
  return response;
}

export async function cacheFirst(request, producer, options = {}) {
  const ttl = Number(options.ttl || NEWS_API_TTL);
  const cacheKey = options.cacheKey || null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return producer();
  }

  const cached = await getCachedResponse(request, cacheKey);

  if (cached) {
    const result = new Response(cached.body, cached);
    result.headers.set("X-Ajker-Cache", "HIT");
    return result;
  }

  const fresh = await producer();

  if (fresh && fresh.ok) {
    const responseForUser = fresh.clone();
    try {
      await putCachedResponse(request, fresh, ttl, cacheKey);
    } catch (error) {
      console.error("Cache storage failed:", error);
    }
    responseForUser.headers.set("X-Ajker-Cache", "MISS");
    return responseForUser;
  }

  return fresh;
}

export async function cacheNewsApi(request, producer) {
  return cacheFirst(request, producer, { ttl: NEWS_API_TTL });
}

export async function cacheArticlePage(request, producer) {
  return cacheFirst(request, producer, { ttl: ARTICLE_TTL });
}

export async function purgeCache(request) {
  const cache = getCache();
  try {
    await cache.delete(request);
    return true;
  } catch (error) {
    console.error("Cache purge failed:", error);
    return false;
  }
}

export async function purgeArticleCache(origin, id) {
  if (!id) return false;
  const url = new URL(`/news/${encodeURIComponent(id)}`, origin);
  const request = new Request(url.toString(), { method: "GET" });
  return purgeCache(request);
}

export async function purgeNewsApiCache(origin) {
  const url = new URL("/api/news", origin);
  const request = new Request(url.toString(), { method: "GET" });
  return purgeCache(request);
}

export const CACHE_CONFIG = {
  newsApiTtl: NEWS_API_TTL,
  articleTtl: ARTICLE_TTL
};
