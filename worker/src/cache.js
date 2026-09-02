/*
 * Cloudflare Cache API helper
 *
 * Purpose:
 * - Cache public news API responses
 * - Cache published article pages
 * - Reduce repeated D1 reads
 * - Improve response speed for visitors
 *
 * Important:
 * API keys are NEVER stored in cache.
 * Only public GET responses are cached.
 */


/*
 * Default cache times.
 *
 * News API:
 * 2 minutes
 *
 * Article page:
 * 10 minutes
 *
 * These values can later be changed.
 */

const NEWS_API_TTL = 120;

const ARTICLE_TTL = 600;


/*
 * Get the Cloudflare cache.
 */
export function getCache() {

  return caches.default;
}


/*
 * Create a cache-safe request.
 *
 * The Cache API works with a Request object.
 */
export function createCacheRequest(
  request,
  cacheKey
) {

  const url =
    new URL(request.url);

  /*
   * Use the supplied cache key while keeping
   * the same hostname.
   */
  if (cacheKey) {
    url.pathname =
      cacheKey.pathname ||
      url.pathname;

    url.search =
      cacheKey.search ||
      "";
  }

  return new Request(
    url.toString(),
    {
      method: "GET",
      headers: request.headers
    }
  );
}


/*
 * Read from Cloudflare cache.
 */
export async function getCachedResponse(
  request,
  cacheKey = null
) {

  const cache =
    getCache();

  const cacheRequest =
    cacheKey
      ? createCacheRequest(
          request,
          cacheKey
        )
      : request;

  const response =
    await cache.match(
      cacheRequest
    );

  return response || null;
}


/*
 * Store a response in Cloudflare cache.
 */
export async function putCachedResponse(
  request,
  response,
  ttl,
  cacheKey = null
) {

  /*
   * Never cache an unsuccessful response.
   */
  if (
    !response ||
    !response.ok
  ) {
    return response;
  }

  const cache =
    getCache();

  const cacheRequest =
    cacheKey
      ? createCacheRequest(
          request,
          cacheKey
        )
      : request;

  /*
   * Clone because the original Response
   * may still be returned to the visitor.
   */
  const cachedResponse =
    new Response(
      response.body,
      response
    );

  /*
   * Tell browsers/CDN how long the response
   * can remain fresh.
   */
  cachedResponse.headers.set(
    "Cache-Control",
    `public, max-age=${ttl}, s-maxage=${ttl}`
  );

  /*
   * Store asynchronously.
   */
  await cache.put(
    cacheRequest,
    cachedResponse.clone()
  );

  return response;
}


/*
 * Complete cache-first operation.
 *
 * If cached:
 *     return cache
 *
 * If not cached:
 *     generate response
 *     store it
 *     return response
 */
export async function cacheFirst(
  request,
  producer,
  options = {}
) {

  const ttl =
    Number(
      options.ttl ||
      NEWS_API_TTL
    );

  const cacheKey =
    options.cacheKey ||
    null;

  /*
   * Only GET/HEAD requests should be cached.
   */
  if (
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    return producer();
  }

  const cached =
    await getCachedResponse(
      request,
      cacheKey
    );

  if (cached) {

    /*
     * Useful for debugging.
     */
    const result =
      new Response(
        cached.body,
        cached
      );

    result.headers.set(
      "X-Ajker-Cache",
      "HIT"
    );

    return result;
  }

  /*
   * Generate fresh response.
   */
  const fresh =
    await producer();

  /*
   * Store only successful responses.
   */
  if (
    fresh &&
    fresh.ok
  ) {

    /*
     * Don't wait for cache storage before
     * returning the response to the visitor.
     */
    const responseForUser =
      fresh.clone();

    /*
     * Cache asynchronously when execution
     * continues.
     */
    try {

      await putCachedResponse(
        request,
        fresh,
        ttl,
        cacheKey
      );

    } catch (error) {

      console.error(
        "Cache storage failed:",
        error
      );
    }

    responseForUser.headers.set(
      "X-Ajker-Cache",
      "MISS"
    );

    return responseForUser;
  }

  return fresh;
}


/*
 * Cache the public news API.
 */
export async function cacheNewsApi(
  request,
  producer
) {

  return cacheFirst(
    request,
    producer,
    {
      ttl:
        NEWS_API_TTL
    }
  );
}


/*
 * Cache individual published news pages.
 */
export async function cacheArticlePage(
  request,
  producer
) {

  return cacheFirst(
    request,
    producer,
    {
      ttl:
        ARTICLE_TTL
    }
  );
}


/*
 * Remove one cached URL.
 *
 * Useful when an article is deleted or changed.
 */
export async function purgeCache(
  request
) {

  const cache =
    getCache();

  try {

    await cache.delete(
      request
    );

    return true;

  } catch (error) {

    console.error(
      "Cache purge failed:",
      error
    );

    return false;
  }
}


/*
 * Purge an article URL by ID.
 */
export async function purgeArticleCache(
  origin,
  id
) {

  if (!id) {
    return false;
  }

  const url =
    new URL(
      `/n/${encodeURIComponent(id)}`,
      origin
    );

  const request =
    new Request(
      url.toString(),
      {
        method: "GET"
      }
    );

  return purgeCache(
    request
  );
}


/*
 * Purge the public news API cache.
 */
export async function purgeNewsApiCache(
  origin
) {

  const url =
    new URL(
      "/api/news",
      origin
    );

  const request =
    new Request(
      url.toString(),
      {
        method: "GET"
      }
    );

  return purgeCache(
    request
  );
}


/*
 * Cache configuration exported for
 * other Worker modules.
 */
export const CACHE_CONFIG = {

  newsApiTtl:
    NEWS_API_TTL,

  articleTtl:
    ARTICLE_TTL

};