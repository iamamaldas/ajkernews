/*
 * GNews fetcher — Hybrid approach (Free Tier Safe)
 *
 * - bn: top-headlines (NO keyword) → ALL Bengali news
 * - en: search with English keywords → English West Bengal news
 * - 15s timeout per API call
 * - 2 retries with 2s delay
 * - ✅ Parallel fetch (bn + en একসাথে)
 */

import { insertCandidate } from "./database.js";
import { makeId, getDayKey } from "./utils.js";

const GNEWS_TOP_HEADLINES_URL = "https://gnews.io/api/v4/top-headlines";
const GNEWS_SEARCH_URL = "https://gnews.io/api/v4/search";

const MAX_PER_LANGUAGE = 10;
const DELAY_BETWEEN_CALLS_MS = 1000;
const GNEWS_TIMEOUT_MS = 15000; // ✅ 15s
const GNEWS_RETRY_DELAY_MS = 2000;

const KEYWORD_SETS = [
  {
    id: "wb-local",
    en: "Kolkata OR Howrah OR Durgapur OR Asansol OR Siliguri OR Darjeeling"
  },
  {
    id: "wb-schemes",
    en: "West Bengal scheme OR Annapurna Bhandar OR Lakshmir Bhandar OR Kanyashree"
  },
  {
    id: "wb-politics",
    en: "West Bengal politics OR Bengal government OR Bengal crime OR Bengal education"
  },
  {
    id: "wb-general",
    en: "West Bengal OR Kolkata news OR Bengal local OR Bengal district"
  }
];

function getKeywordSetForSlot(scheduledTime = Date.now()) {
  const slot = Math.floor(scheduledTime / (2 * 60 * 60 * 1000));
  const index = slot % KEYWORD_SETS.length;
  return KEYWORD_SETS[index];
}

// ✅ Timeout + Retry wrapper
async function fetchWithTimeoutAndRetry(url, options = {}, timeoutMs = GNEWS_TIMEOUT_MS) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetch(url, {
          ...options,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") {
        console.warn(`[FETCH] Timeout after ${timeoutMs}ms (attempt ${attempt}/2)`);
      } else {
        console.warn(`[FETCH] Error (attempt ${attempt}/2): ${error?.message || String(error)}`);
      }

      if (attempt < 2) {
        await new Promise(r => setTimeout(r, GNEWS_RETRY_DELAY_MS));
      }
    }
  }

  throw lastError || new Error("Fetch failed after retries");
}

export async function fetchGNewsBengali(apiKey) {
  if (!apiKey) throw new Error("GNEWS_API_KEY is not configured.");

  console.log(`[FETCH] Fetching Bengali news (top-headlines, no keyword)`);

  const params = new URLSearchParams({
    lang: "bn",
    country: "in",
    max: String(MAX_PER_LANGUAGE),
    apikey: apiKey
  });

  const url = `${GNEWS_TOP_HEADLINES_URL}?${params.toString()}`;

  const response = await fetchWithTimeoutAndRetry(url, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    let errorMessage = `GNews bn request failed: HTTP ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData?.errors) {
        errorMessage += ` - ${
          Array.isArray(errorData.errors)
            ? errorData.errors.join(", ")
            : JSON.stringify(errorData.errors)
        }`;
      }
    } catch {}
    throw new Error(errorMessage);
  }

  const data = await response.json();
  if (!Array.isArray(data.articles)) {
    throw new Error("GNews returned an invalid articles response.");
  }

  console.log(`[FETCH] GNews bn returned ${data.articles.length} articles`);
  return data.articles;
}

export async function fetchGNewsEnglish(apiKey, keywordSet) {
  if (!apiKey) throw new Error("GNEWS_API_KEY is not configured.");

  const query = keywordSet.en;
  console.log(`[FETCH] GNews EN query: ${query}`);

  const params = new URLSearchParams({
    q: query,
    lang: "en",
    country: "in",
    max: String(MAX_PER_LANGUAGE),
    sortby: "publishedAt",
    apikey: apiKey
  });

  const url = `${GNEWS_SEARCH_URL}?${params.toString()}`;

  const response = await fetchWithTimeoutAndRetry(url, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    let errorMessage = `GNews en request failed: HTTP ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData?.errors) {
        errorMessage += ` - ${
          Array.isArray(errorData.errors)
            ? errorData.errors.join(", ")
            : JSON.stringify(errorData.errors)
        }`;
      }
    } catch {}
    throw new Error(errorMessage);
  }

  const data = await response.json();
  if (!Array.isArray(data.articles)) {
    throw new Error("GNews returned an invalid articles response.");
  }

  console.log(`[FETCH] GNews en returned ${data.articles.length} articles`);
  return data.articles;
}

export function normalizeGNewsArticle(article, language, keywordSetId = "general") {
  const sourceUrl = String(article?.url || "").trim();
  const title = String(article?.title || "").trim();
  const description = String(article?.description || "").trim();
  const image = String(article?.image || "").trim();
  const sourceName = String(article?.source?.name || "Unknown source").trim();

  const publishedAt = article?.publishedAt
    ? new Date(article.publishedAt).toISOString()
    : new Date().toISOString();

  const id = String(article?.id || "").trim() || makeId();

  if (!sourceUrl || !title) return null;

  const score = calculateInitialScore(language, publishedAt, keywordSetId);

  const categoryMap = {
    "wb-local": "west_bengal",
    "wb-schemes": "west_bengal",
    "wb-politics": "politics",
    "wb-general": "west_bengal"
  };

  return {
    id,
    source_url: sourceUrl,
    source_name: sourceName,
    source_title: title,
    source_description: description,
    headline: null,
    summary: null,
    main_topic: null,
    category: categoryMap[keywordSetId] || "west_bengal",
    language,
    image_url: image || null,
    published_at: publishedAt,
    created_at: new Date().toISOString(),
    day_key: getDayKey(new Date(publishedAt)),
    score
  };
}

export async function storeGNewsCandidates(db, articles, language, keywordSetId = "general") {
  let inserted = 0;
  let skipped = 0;

  for (const article of articles) {
    const normalized = normalizeGNewsArticle(article, language, keywordSetId);
    if (!normalized) { skipped++; continue; }

    try {
      await insertCandidate(db, normalized);
      inserted++;
    } catch (error) {
      console.error("Failed to store GNews candidate:", error?.message || String(error));
      skipped++;
    }
  }

  return { received: articles.length, inserted, skipped };
}

/*
 * ✅ Parallel Fetch — bn এবং en একসাথে (৫-৭s সাশ্রয়)
 */
export async function runGNewsBatch(db, apiKey, scheduledTime = Date.now()) {
  const keywordSet = getKeywordSetForSlot(scheduledTime);
  console.log(`[FETCH] Keyword set: ${keywordSet.id}`);

  // ✅ Parallel: bn + en একসাথে fetch
  const [bnSettled, enSettled] = await Promise.allSettled([
    (async () => {
      const articles = await fetchGNewsBengali(apiKey);
      return await storeGNewsCandidates(db, articles, "bn", keywordSet.id);
    })(),
    (async () => {
      const articles = await fetchGNewsEnglish(apiKey, keywordSet);
      return await storeGNewsCandidates(db, articles, "en", keywordSet.id);
    })()
  ]);

  const bnResult = bnSettled.status === "fulfilled"
    ? { language: "bn", ...bnSettled.value }
    : { language: "bn", received: 0, inserted: 0, skipped: 0, error: bnSettled.reason?.message };

  const enResult = enSettled.status === "fulfilled"
    ? { language: "en", ...enSettled.value }
    : { language: "en", received: 0, inserted: 0, skipped: 0, error: enSettled.reason?.message };

  if (bnSettled.status === "rejected") {
    console.error(`[FETCH] bn failed:`, bnSettled.reason?.message || String(bnSettled.reason));
  }
  if (enSettled.status === "rejected") {
    console.error(`[FETCH] en failed:`, enSettled.reason?.message || String(enSettled.reason));
  }

  console.log(`[FETCH] bn=${bnResult.inserted} en=${enResult.inserted}`);

  return {
    keywordSet: keywordSet.id,
    batches: [bnResult, enResult],
    totalReceived: (bnResult.received || 0) + (enResult.received || 0),
    totalInserted: (bnResult.inserted || 0) + (enResult.inserted || 0)
  };
}

function calculateInitialScore(language, publishedAt, keywordSetId) {
  const languageBase = language === "bn" ? 12 : 10;

  const categoryBoost =
    keywordSetId === "wb-local" ? 5 :
    keywordSetId === "wb-schemes" ? 3 :
    keywordSetId === "wb-general" ? 3 :
    0;

  const published = new Date(publishedAt).getTime();
  const ageHours = Math.max(0, (Date.now() - published) / (1000 * 60 * 60));
  const freshness = Math.max(0, 10 - Math.min(ageHours, 10));

  return Number((languageBase + categoryBoost + freshness).toFixed(2));
}
