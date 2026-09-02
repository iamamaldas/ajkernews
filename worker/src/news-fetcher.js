import {
  insertCandidate
} from "./database.js";

import {
  makeId,
  getDayKey
} from "./utils.js";


/*
 * GNews configuration
 *
 * We use English source news from India.
 * Gemini will later convert the selected news
 * into natural Bengali short news.
 */

const GNEWS_BASE_URL =
  "https://gnews.io/api/v4/top-headlines";


/*
 * One Cron run = ONE GNews request = 10 articles.
 *
 * Over 24 hours:
 *
 * 8 requests × 10 articles
 * = maximum 80 candidate articles/day
 *
 * The selector will later choose the best 25.
 */

const NEWS_CATEGORIES = [
  "general",
  "world",
  "nation",
  "business",
  "technology",
  "entertainment",
  "sports",
  "science"
];


/*
 * Fetch one batch from GNews.
 */
export async function fetchGNewsBatch(
  apiKey,
  category = "general"
) {

  if (!apiKey) {
    throw new Error(
      "GNEWS_API_KEY is not configured."
    );
  }

  const params = new URLSearchParams({
    category,
    lang: "en",
    country: "in",
    max: "10",
    apikey: apiKey
  });

  const url =
    `${GNEWS_BASE_URL}?${params.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  /*
   * Always check the HTTP status.
   */
  if (!response.ok) {

    let errorMessage =
      `GNews request failed: HTTP ${response.status}`;

    try {

      const errorData =
        await response.json();

      if (errorData?.errors) {

        if (Array.isArray(errorData.errors)) {
          errorMessage +=
            ` - ${errorData.errors.join(", ")}`;
        } else {
          errorMessage +=
            ` - ${JSON.stringify(errorData.errors)}`;
        }
      }

    } catch {
      // Ignore JSON parsing failure.
    }

    throw new Error(errorMessage);
  }

  const data =
    await response.json();

  if (!Array.isArray(data.articles)) {
    throw new Error(
      "GNews returned an invalid articles response."
    );
  }

  return data.articles;
}


/*
 * Convert a GNews article into our internal
 * database candidate format.
 */
export function normalizeGNewsArticle(
  article,
  category
) {

  const sourceUrl =
    String(article?.url || "").trim();

  const title =
    String(article?.title || "").trim();

  const description =
    String(article?.description || "").trim();

  const image =
    String(article?.image || "").trim();

  const sourceName =
    String(
      article?.source?.name || "Unknown source"
    ).trim();

  const publishedAt =
    article?.publishedAt
      ? new Date(article.publishedAt).toISOString()
      : new Date().toISOString();

  /*
   * GNews provides its own article ID.
   * If it is unavailable, create our own ID.
   */
  const id =
    String(article?.id || "").trim() ||
    makeId();

  /*
   * A source URL is essential.
   * Articles without a valid URL are ignored.
   */
  if (!sourceUrl || !title) {
    return null;
  }

  /*
   * Initial score only.
   *
   * The real quality/importance scoring will be
   * performed by news-selector.js later.
   */
  const score =
    calculateInitialScore(
      category,
      publishedAt
    );

  return {

    id,

    source_url:
      sourceUrl,

    source_name:
      sourceName,

    source_title:
      title,

    source_description:
      description,

    headline:
      null,

    summary:
      null,

    main_topic:
      null,

    category,

    image_url:
      image || null,

    published_at:
      publishedAt,

    created_at:
      Date.now(),

    day_key:
      getDayKey(
        new Date(publishedAt)
      ),

    score
  };
}


/*
 * Insert one batch into D1 as candidates.
 *
 * INSERT OR IGNORE in database.js prevents
 * the same source URL from being inserted again.
 */
export async function storeGNewsCandidates(
  db,
  articles,
  category
) {

  let inserted = 0;
  let skipped = 0;

  for (const article of articles) {

    const normalized =
      normalizeGNewsArticle(
        article,
        category
      );

    if (!normalized) {
      skipped++;
      continue;
    }

    try {

      await insertCandidate(
        db,
        normalized
      );

      inserted++;

    } catch (error) {

      console.error(
        "Failed to store GNews candidate:",
        error
      );

      skipped++;
    }
  }

  return {
    received: articles.length,
    inserted,
    skipped
  };
}


/*
 * Complete one scheduled GNews run.
 *
 * Example:
 *
 * 03:00 → general
 * 06:00 → world
 * 09:00 → nation
 * 12:00 → business
 * 15:00 → technology
 * 18:00 → entertainment
 * 21:00 → sports
 * 00:00 → science
 *
 * The exact UTC schedule will be handled by
 * the Cloudflare Cron trigger.
 */
export async function runGNewsBatch(
  db,
  apiKey,
  category
) {

  console.log(
    `GNews batch started: ${category}`
  );

  const articles =
    await fetchGNewsBatch(
      apiKey,
      category
    );

  const result =
    await storeGNewsCandidates(
      db,
      articles,
      category
    );

  console.log(
    "GNews batch completed:",
    {
      category,
      ...result
    }
  );

  return {
    category,
    ...result
  };
}


/*
 * Select the category for the current Cron slot.
 *
 * There are 8 categories because we have
 * 8 scheduled runs in 24 hours.
 */
export function getCategoryForCronSlot(
  scheduledTime
) {

  const date =
    new Date(scheduledTime);

  const hour =
    date.getUTCHours();

  const slot =
    Math.floor(hour / 3);

  return NEWS_CATEGORIES[
    slot % NEWS_CATEGORIES.length
  ];
}


/*
 * Small preliminary score.
 *
 * This is NOT the final selection score.
 *
 * news-selector.js will later consider:
 * - freshness
 * - importance
 * - duplicate stories
 * - source quality
 * - category balance
 * - relevance
 */
function calculateInitialScore(
  category,
  publishedAt
) {

  const categoryWeight = {
    general: 10,
    world: 9,
    nation: 10,
    business: 8,
    technology: 8,
    entertainment: 5,
    sports: 6,
    science: 8
  };

  const base =
    categoryWeight[category] || 5;

  const published =
    new Date(publishedAt).getTime();

  const ageHours =
    Math.max(
      0,
      (Date.now() - published) /
      (1000 * 60 * 60)
    );

  /*
   * Newer news receives a slightly higher
   * preliminary score.
   */
  const freshness =
    Math.max(
      0,
      10 - Math.min(ageHours, 10)
    );

  return Number(
    (base + freshness).toFixed(2)
  );
}