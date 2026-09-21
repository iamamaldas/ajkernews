/*
 * Cloudflare Cache API helper — Multi-key purge
 * v2 — Added dynamic TTL support for cacheNewsApi
 */

const NEWS_API_TTL = 60;
const ARTICLE_TTL = 300;

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
  const ttl = Number(options.ttl !== undefined ? options.ttl : NEWS_API_TTL);
  const cacheKey = options.cacheKey || null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return producer();
  }

  // ✅ If TTL is 0, skip cache entirely and always fetch fresh
  if (ttl === 0) {
    const fresh = await producer();
    if (fresh && fresh.ok) {
      fresh.headers.set("X-Ajker-Cache", "BYPASS");
    }
    return fresh;
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

// ✅ FIXED: Added TTL parameter support
export async function cacheNewsApi(request, producer, ttl = NEWS_API_TTL) {
  return cacheFirst(request, producer, { ttl });
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
  const cache = getCache();
  // ✅ EXPANDED: More URL variations to ensure full purge
  const variations = [
    `/api/news`,
    `/api/news?category=top&limit=10`,
    `/api/news?category=top&limit=20`,
    `/api/news?category=top&limit=10&offset=0`,
    `/api/news?category=all&limit=10`,
    `/api/news?category=all&limit=20`,
    `/api/news?category=all&limit=10&offset=0`,
    `/api/news?category=trending&limit=10`,
    `/api/news?category=trending&limit=20`,
    `/api/news?limit=10`,
    `/api/news?limit=20`,
    `/api/news?offset=0&limit=10`,
    `/api/news?category=top&limit=20&offset=0`,
    `/api/news?category=all&limit=20&offset=0`,
    `/api/news?category=trending&limit=10&offset=0`
  ];

  let purged = 0;
  for (const path of variations) {
    try {
      const url = new URL(path, origin);
      const request = new Request(url.toString(), { method: "GET" });
      const ok = await cache.delete(request);
      if (ok) purged++;
    } catch (e) {
      console.warn(`[CACHE] Purge failed for ${path}:`, e?.message);
    }
  }
  console.log(`[CACHE] Purged ${purged}/${variations.length} API cache keys`);
  return purged > 0;
}

export const CACHE_CONFIG = {
  newsApiTtl: NEWS_API_TTL,
  articleTtl: ARTICLE_TTL
};
