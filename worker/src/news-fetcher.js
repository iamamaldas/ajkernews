/*
 * GNews fetcher — smart keyword rotation
 *
 * Strategy:
 * - 2 languages: bn + en
 * - 10 articles per request (free-tier max)
 * - 4 keyword sets, rotating every slot
 * - No person names — only designations (CM, PM, Minister)
 * - Includes current schemes (Annapurna Bhandar, etc.)
 * - Includes viral/trending/world news
 */

import { insertCandidate } from "./database.js";
import { makeId, getDayKey } from "./utils.js";

const GNEWS_BASE_URL = "https://gnews.io/api/v4/search";

const MAX_PER_LANGUAGE = 10;
const GNEWS_LANGUAGES = ["bn", "en"];
const DELAY_BETWEEN_CALLS_MS = 1000;

/*
 * ✅ 4 keyword sets — rotating every 2 hours
 *
 * Set 1: Designations (CM, PM, Minister, Governor)
 * Set 2: Government schemes (Annapurna Bhandar, Lakshmir Bhandar, etc.)
 * Set 3: World news + viral/trending
 * Set 4: Local (Kolkata, Howrah, districts) + category
 */
const KEYWORD_SETS = [
  {
    id: "designations",
    bn: "মুখ্যমন্ত্রী OR প্রধানমন্ত্রী OR স্বরাষ্ট্রমন্ত্রী OR রাজ্যপাল OR মন্ত্রিসভা",
    en: "Chief Minister OR Prime Minister OR Home Minister OR Governor OR Cabinet"
  },
  {
    id: "schemes",
    bn: "অন্নপূর্ণা ভাণ্ডার OR লক্ষ্মীর ভাণ্ডার OR কন্যাশ্রী OR দুয়ারে সরকার OR স্বাস্থ্য সাথী OR কৃষক বন্ধু",
    en: "Annapurna Bhandar OR Lakshmir Bhandar OR Kanyashree OR Duare Sarkar OR Swasthya Sathi OR Krishak Bandhu"
  },
  {
    id: "world",
    bn: "দেশ-বিদেশ OR আন্তর্জাতিক OR ভাইরাল OR ব্রেকিং নিউজ OR বিশ্ব",
    en: "world news OR international OR viral OR breaking news OR trending"
  },
  {
    id: "local",
    bn: "কলকাতা OR হাওড়া OR দুর্গাপুর OR দার্জিলিং OR রাজনীতি OR অপরাধ OR শিক্ষা",
    en: "Kolkata OR Howrah OR Durgapur OR Darjeeling OR politics OR crime OR education"
  }
];

/*
 * ✅ Pick the keyword set for the current time slot.
 * Slot = current hour / 2 → rotates every 2 hours.
 */
function getKeywordSetForSlot(scheduledTime = Date.now()) {
  const slot = Math.floor(scheduledTime / (2 * 60 * 60 * 1000));
  const index = slot % KEYWORD_SETS.length;
  return KEYWORD_SETS[index];
}

export async function fetchGNewsBatch(apiKey, language = "en", keywordSet = null) {
  if (!apiKey) {
    throw new Error("GNEWS_API_KEY is not configured.");
  }

  const set = keywordSet || KEYWORD_SETS[0];
  const query = language === "bn" ? set.bn : set.en;

  const params = new URLSearchParams({
    q: query,
    lang: language,
    country: "in",
    max: String(MAX_PER_LANGUAGE),
    sortby: "publishedAt",
    apikey: apiKey
  });

  const url = `${GNEWS_BASE_URL}?${params.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    let errorMessage = `GNews ${language} request failed: HTTP ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData?.errors) {
        errorMessage += ` - ${
          Array.isArray(errorData.errors)
            ? errorData.errors.join(", ")
            : JSON.stringify(errorData.errors)
        }`;
      }
    } catch {
      // ignore
    }
    throw new Error(errorMessage);
  }

  const data = await response.json();

  if (!Array.isArray(data.articles)) {
    throw new Error("GNews returned an invalid articles response.");
  }

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

  if (!sourceUrl || !title) {
    return null;
  }

  const score = calculateInitialScore(language, publishedAt, keywordSetId);

  // Map keyword set id → category
  const categoryMap = {
    designations: "politics",
    schemes: "general",
    world: "world",
    local: "general"
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

    if (!normalized) {
      skipped++;
      continue;
    }

    try {
      await insertCandidate(db, normalized);
      inserted++;
    } catch (error) {
      console.error("Failed to store GNews candidate:", error?.message || String(error));
      skipped++;
    }
  }

  return {
    received: articles.length,
    inserted,
    skipped
  };
}

export async function runGNewsBatch(db, apiKey, scheduledTime = Date.now()) {
  const keywordSet = getKeywordSetForSlot(scheduledTime);
  console.log(`[FETCH] Keyword set for this slot: ${keywordSet.id}`);
  console.log(`[FETCH] BN query: ${keywordSet.bn}`);
  console.log(`[FETCH] EN query: ${keywordSet.en}`);

  const results = [];

  for (const language of GNEWS_LANGUAGES) {
    try {
      console.log(`[FETCH] Fetching GNews lang=${language}`);
      const articles = await fetchGNewsBatch(apiKey, language, keywordSet);
      const result = await storeGNewsCandidates(db, articles, language, keywordSet.id);
      console.log(
        `[FETCH] lang=${language} received=${result.received} inserted=${result.inserted} skipped=${result.skipped}`
      );
      results.push({ language, keywordSet: keywordSet.id, ...result });
    } catch (error) {
      console.error(`[FETCH] GNews ${language} failed:`, error?.message || String(error));
      results.push({
        language,
        keywordSet: keywordSet.id,
        received: 0,
        inserted: 0,
        skipped: 0,
        error: error?.message
      });
    }

    // 1 second delay between languages (rate limit safety)
    if (GNEWS_LANGUAGES.indexOf(language) < GNEWS_LANGUAGES.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CALLS_MS));
    }
  }

  return {
    keywordSet: keywordSet.id,
    batches: results,
    totalReceived: results.reduce((sum, r) => sum + (r.received || 0), 0),
    totalInserted: results.reduce((sum, r) => sum + (r.inserted || 0), 0)
  };
}

function calculateInitialScore(language, publishedAt, keywordSetId) {
  const languageBase = language === "bn" ? 12 : 10;

  // Boost schemes and world news
  const categoryBoost =
    keywordSetId === "schemes" ? 3 :
    keywordSetId === "world" ? 2 :
    0;

  const published = new Date(publishedAt).getTime();
  const ageHours = Math.max(0, (Date.now() - published) / (1000 * 60 * 60));
  const freshness = Math.max(0, 10 - Math.min(ageHours, 10));

  return Number((languageBase + categoryBoost + freshness).toFixed(2));
}
