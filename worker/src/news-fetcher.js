/*
 * GNews fetcher — Hybrid approach (Free Tier Safe)
 *
 * - bn: top-headlines (NO keyword) → ALL Bengali news
 * - en: search with English keywords → Top media + trending + important
 * - 15s timeout per API call
 * - 2 retries with 2s delay
 * - ✅ Parallel fetch (bn + en একসাথে)
 * - ✅ 429 Rate Limit → Stop retrying immediately
 * - ✅ Quality filter before storing
 * - ✅ Top media priority + Expanded Keyword Sets
 */

import { insertCandidate } from "./database.js";
import { makeId, getDayKey } from "./utils.js";

const GNEWS_TOP_HEADLINES_URL = "https://gnews.io/api/v4/top-headlines";
const GNEWS_SEARCH_URL = "https://gnews.io/api/v4/search";

const MAX_PER_LANGUAGE = 10;
const GNEWS_TIMEOUT_MS = 15000;
const GNEWS_RETRY_DELAY_MS = 2000;

// ✅ Quality filter thresholds
const MIN_TITLE_LENGTH = 30;
const MIN_DESCRIPTION_LENGTH = 80;

/* =========================================================
 * ✅ EXPANDED KEYWORD SETS — Top Media + Important News
 * ========================================================= */
const KEYWORD_SETS = [
  // ✅ আগের মিডিয়া-ভিত্তিক সেট (বড় মিডিয়ার খবর)
  {
    id: "top-media",
    en: `"ABP Ananda" OR "Aaj Tak" OR "Times of India" OR "TV9 Bangla" OR "The Hindu" OR "NDTV" OR "Hindustan Times" OR "Indian Express" OR "Anandabazar" OR "Bartaman" OR "Ei Samay" OR "News18 Bangla"`
  },
  // ✅ নতুন টপিক-ভিত্তিক সেট (দেশ-বিদেশের গুরুত্বপূর্ণ খবর)
  {
    id: "wb-breaking",
    en: `"West Bengal breaking news" OR "Kolkata breaking" OR "Bengal government" OR "Kolkata police"`
  },
  // ✅ নতুন সেট: বাংলার রাজনীতি
  {
    id: "wb-politics",
    en: `"West Bengal politics" OR "TMC BJP" OR "Bengal election" OR "Mamata Banerjee"`
  },
  // ✅ নতুন সেট: ভারতের ট্রেন্ডিং
  {
    id: "india-trending",
    en: `"India trending news" OR "viral news India" OR "breaking India" OR "Supreme Court India"`
  },
  // ✅ আগের জাতীয় মিডিয়া সেট
  {
    id: "national-media",
    en: `"India Today" OR "Economic Times" OR "Livemint" OR "Business Standard" OR "Zee News" OR "Republic" OR "Firstpost" OR "Telegraph India"`
  },
  // ✅ নতুন সেট: ভারতের জাতীয় গুরুত্বপূর্ণ খবর
  {
    id: "india-national",
    en: `"India government scheme" OR "Parliament India" OR "Indian economy" OR "Indian education" OR "Indian railways"`
  },
  // ✅ আগের আন্তর্জাতিক সেট
  {
    id: "international",
    en: `"World news" OR "International breaking" OR "Global news" OR "US news" OR "UK news" OR "Reuters" OR "BBC" OR "Al Jazeera"`
  },
  // ✅ নতুন সেট: ভাইরাল এবং ব্রেকিং নিউজ
  {
    id: "trending-viral",
    en: `"viral video" OR "trending now" OR "breaking news" OR "big announcement" OR "emergency news"`
  },
  // ✅ নতুন সেট: সাধারণ গুরুত্বপূর্ণ খবর
  {
    id: "general-important",
    en: `"important news India" OR "big update India" OR "government announcement" OR "public interest news"`
  }
];

function getKeywordSetForSlot(scheduledTime = Date.now()) {
  const slot = Math.floor(scheduledTime / (1 * 60 * 60 * 1000)); // ✅ প্রতি ঘণ্টায় রোটেট
  const index = slot % KEYWORD_SETS.length;
  return KEYWORD_SETS[index];
}

/* =========================================================
 * ✅ Timeout + Retry + 429 Handler
 * ========================================================= */
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

      if (response.status === 429) {
        console.warn(`[FETCH] 429 Rate Limit Hit. Stopping retries to save quota.`);
        return response;
      }

      if (response.status === 401 || response.status === 403) {
        console.warn(`[FETCH] ${response.status} Auth Error. Stopping retries.`);
        return response;
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

/* =========================================================
 * Fetch Bengali News
 * ========================================================= */
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

/* =========================================================
 * Fetch English News
 * ========================================================= */
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

/* =========================================================
 * Normalize GNews Article
 * ========================================================= */
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

  // ✅ Quality filter — কম কোয়ালিটির নিউজ বাদ
  if (title.length < MIN_TITLE_LENGTH) {
    console.log(`[FILTER] Title too short: ${title.slice(0, 40)}...`);
    return null;
  }
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    console.log(`[FILTER] Description too short: ${title.slice(0, 40)}...`);
    return null;
  }
  if (sourceName.toLowerCase().includes("unknown")) {
    console.log(`[FILTER] Unknown source: ${title.slice(0, 40)}...`);
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

/* =========================================================
 * Store Candidates to D1
 * ========================================================= */
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

/* =========================================================
 * ✅ Parallel Fetch — bn + en একসাথে
 * ========================================================= */
export async function runGNewsBatch(db, apiKey, scheduledTime = Date.now()) {
  const keywordSet = getKeywordSetForSlot(scheduledTime);
  console.log(`[FETCH] Keyword set: ${keywordSet.id}`);

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

/* =========================================================
 * Initial Score Calculator
 * ========================================================= */
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
    keywordSetId === "general-important" ? 5 :
    0;

  const published = new Date(publishedAt).getTime();
  const ageHours = Math.max(0, (Date.now() - published) / (1000 * 60 * 60));
  const freshness = Math.max(0, 10 - Math.min(ageHours, 10));

  // ✅ Title/Description এ trending/viral শব্দ থাকলে বাড়তি স্কোর
  let viralBonus = 0;
  const combined = (title + " " + description).toLowerCase();
  if (combined.includes("breaking") || combined.includes("viral") || combined.includes("trending")) {
    viralBonus = 8;
  }

  return Number((languageBase + categoryBoost + freshness + viralBonus).toFixed(2));
}
