/*
 * GNews fetcher — free-tier optimized
 *
 * Strategy:
 * - 2 languages: bn + en
 * - 10 articles per request (free-tier max)
 * - Keyword search: West Bengal / Kolkata / politics / scheme
 * - 1 second delay between bn and en calls (rate limit safe)
 */

import { insertCandidate } from "./database.js";
import { makeId, getDayKey } from "./utils.js";

const GNEWS_BASE_URL = "https://gnews.io/api/v4/search";

const MAX_PER_LANGUAGE = 10;
const GNEWS_LANGUAGES = ["bn", "en"];
const DELAY_BETWEEN_CALLS_MS = 1000;

const SEARCH_QUERY =
  "West Bengal OR Kolkata OR Mamata OR TMC OR Bengal government OR West Bengal scheme";

export async function fetchGNewsBatch(apiKey, language = "en") {
  if (!apiKey) {
    throw new Error("GNEWS_API_KEY is not configured.");
  }

  const params = new URLSearchParams({
    q: SEARCH_QUERY,
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

export function normalizeGNewsArticle(article, language) {
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

  const score = calculateInitialScore(language, publishedAt);

  return {
    id,
    source_url: sourceUrl,
    source_name: sourceName,
    source_title: title,
    source_description: description,
    headline: null,
    summary: null,
    main_topic: null,
    category: "general",
    language,
    image_url: image || null,
    published_at: publishedAt,
    created_at: new Date().toISOString(),
    day_key: getDayKey(new Date(publishedAt)),
    score
  };
}

export async function storeGNewsCandidates(db, articles, language) {
  let inserted = 0;
  let skipped = 0;

  for (const article of articles) {
    const normalized = normalizeGNewsArticle(article, language);

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

export async function runGNewsBatch(db, apiKey) {
  const results = [];

  for (const language of GNEWS_LANGUAGES) {
    try {
      console.log(`[FETCH] Fetching GNews lang=${language}`);
      const articles = await fetchGNewsBatch(apiKey, language);
      const result = await storeGNewsCandidates(db, articles, language);
      console.log(
        `[FETCH] lang=${language} received=${result.received} inserted=${result.inserted} skipped=${result.skipped}`
      );
      results.push({ language, ...result });
    } catch (error) {
      console.error(`[FETCH] GNews ${language} failed:`, error?.message || String(error));
      results.push({ language, received: 0, inserted: 0, skipped: 0, error: error?.message });
    }

    // 1 second delay between languages (rate limit safety)
    if (GNEWS_LANGUAGES.indexOf(language) < GNEWS_LANGUAGES.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CALLS_MS));
    }
  }

  return {
    batches: results,
    totalReceived: results.reduce((sum, r) => sum + (r.received || 0), 0),
    totalInserted: results.reduce((sum, r) => sum + (r.inserted || 0), 0)
  };
}

function calculateInitialScore(language, publishedAt) {
  const base = language === "bn" ? 12 : 10;

  const published = new Date(publishedAt).getTime();
  const ageHours = Math.max(0, (Date.now() - published) / (1000 * 60 * 60));
  const freshness = Math.max(0, 10 - Math.min(ageHours, 10));

  return Number((base + freshness).toFixed(2));
}
