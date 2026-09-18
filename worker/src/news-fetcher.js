/*
 * GNews fetcher — Quota-optimized
 *
 * - Free tier safe: 24 req/day (limit 100)
 * - Serial fetch (bn → 3s gap → en) to avoid burst 429
 * - MAX_PER_LANGUAGE = 8 (more candidates)
 * - 429-safe: returns empty list instead of throwing
 * - 15s timeout per API call
 * - 2 retries with 2s delay
 * - Quality filter before storing
 */

import { insertCandidate } from "./database.js";
import { makeId, getDayKey } from "./utils.js";

const GNEWS_TOP_HEADLINES_URL = "https://gnews.io/api/v4/top-headlines";
const GNEWS_SEARCH_URL = "https://gnews.io/api/v4/search";

// Quota-safe: 8 per language (was 5)
const MAX_PER_LANGUAGE = 8;
const GNEWS_TIMEOUT_MS = 15000;
const GNEWS_RETRY_DELAY_MS = 2000;
const GNEWS_SERIAL_GAP_MS = 3000;

// Quality filter thresholds
const MIN_TITLE_LENGTH = 25;
const MIN_DESCRIPTION_LENGTH = 60;

const KEYWORD_SETS = [
  {
    id: "top-media",
    en: `"ABP Ananda" OR "Aaj Tak" OR "Times of India" OR "TV9 Bangla" OR "The Hindu" OR "NDTV" OR "Hindustan Times" OR "Indian Express" OR "Anandabazar" OR "Bartaman" OR "Ei Samay" OR "News18 Bangla"`
  },
  {
    id: "wb-breaking",
    en: `"West Bengal breaking news" OR "Kolkata breaking" OR "Bengal government" OR "Kolkata police"`
  },
  {
    id: "wb-politics",
    en: `"West Bengal politics" OR "TMC BJP" OR "Bengal election" OR "Mamata Banerjee"`
  },
  {
    id: "india-trending",
    en: `"India trending news" OR "viral news India" OR "breaking India" OR "Supreme Court India"`
  },
  {
    id: "national-media",
    en: `"India Today" OR "Economic Times" OR "Livemint" OR "Business Standard" OR "Zee News" OR "Republic" OR "Firstpost" OR "Telegraph India"`
  },
  {
    id: "india-national",
    en: `"India government scheme" OR "Parliament India" OR "Indian economy" OR "Indian education" OR "Indian railways"`
  },
  {
    id: "international",
    en: `"World news" OR "International breaking" OR "Global news" OR "US news" OR "UK news" OR "Reuters" OR "BBC" OR "Al Jazeera"`
  },
  {
    id: "trending-viral",
    en: `"viral video" OR "trending now" OR "breaking news" OR "big announcement" OR "emergency news"`
  },
  {
    id: "general-important",
    en: `"important news India" OR "big update India" OR "government announcement" OR "public interest news"`
  }
];

function getKeywordSetForSlot(scheduledTime = Date.now()) {
  const slot = Math.floor(scheduledTime / (2 * 60 * 60 * 1000));
  const index = slot % KEYWORD_SETS.length;
  return KEYWORD_SETS[index];
}

async function fetchWithTimeoutAndRetry(url, options = {}, timeoutMs = GNEWS_TIMEOUT_MS) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.status === 429) {
        console.warn(`[FETCH] 429 Rate Limit. Stopping retries.`);
        return response;
      }

      if (response.status === 401 || response.status === 403) {
        console.warn(`[FETCH] ${response.status} Auth Error.`);
        return response;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") {
        console.warn(`[FETCH] Timeout ${timeoutMs}ms (attempt ${attempt}/2)`);
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

async function parseGNewsResponse(response, label) {
  if (response.status === 429) {
    console.warn(`[FETCH] ${label} 429 rate limit — empty list`);
    return [];
  }

  if (!response.ok) {
    let errorMessage = `GNews ${label} failed: HTTP ${response.status}`;
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
    throw new Error(`GNews ${label} invalid articles response.`);
  }

  console.log(`[FETCH] GNews ${label} returned ${data.articles.length} articles`);
  return data.articles;
}

export async function fetchGNewsBengali(apiKey) {
  if (!apiKey) throw new Error("GNEWS_API_KEY is not configured.");

  console.log(`[FETCH] Bengali news (top-headlines)`);

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

  return await parseGNewsResponse(response, "bn");
}

export async function fetchGNewsEnglish(apiKey, keywordSet) {
  if (!apiKey) throw new Error("GNEWS_API_KEY is not configured.");

  const query = keywordSet.en;
  console.log(`[FETCH] EN query: ${query.slice(0, 80)}...`);

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

  return await parseGNewsResponse(response, "en");
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

  if (title.length < MIN_TITLE_LENGTH) {
    return null;
  }
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    return null;
  }
  if (sourceName.toLowerCase().includes("unknown")) {
    return null;
  }

  const score = calculateInitialScore(language, publishedAt, keywordSetId, title, description);

  const categoryMap = {
    "top-media": "general",
    "wb-breaking": "west_bengal",
    "wb-politics": "politics",
    "india-trending": "india",
    "national-media": "india",
    "india-national": "india",
    "international": "world",
    "trending-viral": "trending",
    "general-important": "general"
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
    category: categoryMap[keywordSetId] || "general",
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
      console.error("Failed to store candidate:", error?.message || String(error));
      skipped++;
    }
  }

  return { received: articles.length, inserted, skipped };
}

export async function runGNewsBatch(db, apiKey, scheduledTime = Date.now()) {
  const keywordSet = getKeywordSetForSlot(scheduledTime);
  console.log(`[FETCH] Keyword set: ${keywordSet.id}`);

  const results = [];

  try {
    const articles = await fetchGNewsBengali(apiKey);
    const stored = await storeGNewsCandidates(db, articles, "bn", keywordSet.id);
    results.push({ language: "bn", ...stored });
    console.log(`[FETCH] bn inserted: ${stored.inserted}`);
  } catch (error) {
    console.error(`[FETCH] bn failed:`, error?.message || String(error));
    results.push({ language: "bn", received: 0, inserted: 0, skipped: 0, error: error?.message });
  }

  console.log(`[FETCH] Waiting ${GNEWS_SERIAL_GAP_MS}ms before EN fetch...`);
  await new Promise(r => setTimeout(r, GNEWS_SERIAL_GAP_MS));

  try {
    const articles = await fetchGNewsEnglish(apiKey, keywordSet);
    const stored = await storeGNewsCandidates(db, articles, "en", keywordSet.id);
    results.push({ language: "en", ...stored });
    console.log(`[FETCH] en inserted: ${stored.inserted}`);
  } catch (error) {
    console.error(`[FETCH] en failed:`, error?.message || String(error));
    results.push({ language: "en", received: 0, inserted: 0, skipped: 0, error: error?.message });
  }

  const bnResult = results.find(r => r.language === "bn") || { received: 0, inserted: 0 };
  const enResult = results.find(r => r.language === "en") || { received: 0, inserted: 0 };

  console.log(`[FETCH] total: bn=${bnResult.inserted} en=${enResult.inserted}`);

  return {
    keywordSet: keywordSet.id,
    batches: results,
    totalReceived: (bnResult.received || 0) + (enResult.received || 0),
    totalInserted: (bnResult.inserted || 0) + (enResult.inserted || 0)
  };
}

function calculateInitialScore(language, publishedAt, keywordSetId, title = "", description = "") {
  const languageBase = language === "bn" ? 12 : 10;

  const categoryBoost =
    keywordSetId === "top-media" ? 8 :
    keywordSetId === "wb-breaking" ? 6 :
    keywordSetId === "wb-politics" ? 6 :
    keywordSetId === "india-trending" ? 5 :
    keywordSetId === "national-media" ? 5 :
    keywordSetId === "india-national" ? 6 :
    keywordSetId === "international" ? 4 :
    keywordSetId === "trending-viral" ? 7 :
    keywordSetId === "general-important" ? 5 : 0;

  const published = new Date(publishedAt).getTime();
  const ageHours = Math.max(0, (Date.now() - published) / (1000 * 60 * 60));
  const freshness = Math.max(0, 10 - Math.min(ageHours, 10));

  let viralBonus = 0;
  const combined = (title + " " + description).toLowerCase();
  if (combined.includes("breaking") || combined.includes("viral") || combined.includes("trending")) {
    viralBonus = 8;
  }

  return Number((languageBase + categoryBoost + freshness + viralBonus).toFixed(2));
}
