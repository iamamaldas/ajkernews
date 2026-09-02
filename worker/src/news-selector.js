import {
  publishNews,
  deleteNews
} from "./database.js";

import {
  normalizeText
} from "./utils.js";


/*
 * FINAL DAILY LIMIT
 *
 * Maximum published news = 25
 */
const MAX_DAILY_NEWS = 25;


/*
 * Maximum total stored records.
 *
 * This includes candidate + published news.
 * The database cleanup will keep the total at 200.
 */
const MAX_TOTAL_NEWS = 200;


/*
 * Select the best news from the candidates.
 *
 * Selection considers:
 *
 * 1. Freshness
 * 2. Initial score
 * 3. Source quality
 * 4. Description quality
 * 5. Image availability
 * 6. Duplicate/similar story detection
 * 7. Category diversity
 */
export function selectBestCandidates(
  candidates,
  existingPublished = []
) {

  if (!Array.isArray(candidates)) {
    return [];
  }

  /*
   * First remove obvious duplicate URLs.
   */
  const uniqueByUrl =
    removeDuplicateUrls(candidates);

  /*
   * Remove very similar headlines/stories.
   */
  const uniqueStories =
    removeSimilarStories(
      uniqueByUrl,
      existingPublished
    );

  /*
   * Score every remaining candidate.
   */
  const scored =
    uniqueStories.map(article => {

      const score =
        calculateQualityScore(article);

      return {
        ...article,
        score
      };
    });

  /*
   * Highest score first.
   */
  scored.sort(
    (a, b) => b.score - a.score
  );

  /*
   * Keep category diversity.
   *
   * This prevents all 25 stories from being
   * from only one category.
   */
  return selectWithCategoryBalance(
    scored,
    MAX_DAILY_NEWS
  );
}


/*
 * Remove duplicate source URLs.
 */
function removeDuplicateUrls(
  articles
) {

  const seen =
    new Set();

  const result = [];

  for (const article of articles) {

    const url =
      String(
        article.source_url || ""
      ).trim();

    if (!url) {
      continue;
    }

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    result.push(article);
  }

  return result;
}


/*
 * Detect similar stories.
 *
 * This is deliberately conservative.
 *
 * We compare meaningful words from headlines.
 * We do NOT delete articles merely because they
 * share one or two common words.
 */
function removeSimilarStories(
  candidates,
  existingPublished
) {

  const accepted = [];

  /*
   * Existing published stories are also considered,
   * so a story already displayed on the website
   * will not be published again unnecessarily.
   */
  const existing =
    Array.isArray(existingPublished)
      ? existingPublished
      : [];

  for (const article of candidates) {

    const title =
      normalizeTitle(
        article.source_title
      );

    if (!title) {
      continue;
    }

    /*
     * Compare with already published stories.
     */
    let duplicate =
      false;

    for (const oldArticle of existing) {

      const oldTitle =
        normalizeTitle(
          oldArticle.source_title ||
          oldArticle.headline
        );

      if (
        oldTitle &&
        areSimilarStories(
          title,
          oldTitle
        )
      ) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) {
      continue;
    }

    /*
     * Compare with candidates already accepted
     * during this selection.
     */
    for (const selected of accepted) {

      const selectedTitle =
        normalizeTitle(
          selected.source_title
        );

      if (
        selectedTitle &&
        areSimilarStories(
          title,
          selectedTitle
        )
      ) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) {
      continue;
    }

    accepted.push(article);
  }

  return accepted;
}


/*
 * Normalize a headline for similarity checking.
 */
function normalizeTitle(
  title = ""
) {

  return normalizeText(title)
    .split(/\s+/)
    .filter(word =>
      word.length >= 3
    )
    .filter(word =>
      !STOP_WORDS.has(word)
    );
}


/*
 * Stop words used only for duplicate detection.
 */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "have",
  "has",
  "will",
  "into",
  "after",
  "before",
  "about",
  "over",
  "under",
  "says",
  "said",
  "new",
  "news",
  "india",
  "today"
]);


/*
 * Calculate similarity between two headlines.
 */
function areSimilarStories(
  wordsA,
  wordsB
) {

  if (
    !wordsA.length ||
    !wordsB.length
  ) {
    return false;
  }

  const setA =
    new Set(wordsA);

  const setB =
    new Set(wordsB);

  let common = 0;

  for (const word of setA) {

    if (setB.has(word)) {
      common++;
    }
  }

  const smaller =
    Math.min(
      setA.size,
      setB.size
    );

  if (!smaller) {
    return false;
  }

  const similarity =
    common / smaller;

  /*
   * High overlap = likely same story.
   */
  return similarity >= 0.65;
}


/*
 * Quality scoring.
 *
 * This is NOT intended to "fake" Google ranking.
 * It simply helps us choose useful news before
 * Gemini processes them.
 */
function calculateQualityScore(
  article
) {

  let score =
    Number(article.score || 0);

  const title =
    String(
      article.source_title || ""
    ).trim();

  const description =
    String(
      article.source_description || ""
    ).trim();

  const source =
    String(
      article.source_name || ""
    ).trim();

  /*
   * Good headline.
   */
  if (
    title.length >= 35 &&
    title.length <= 180
  ) {
    score += 5;
  }

  /*
   * Useful description.
   */
  if (
    description.length >= 80
  ) {
    score += 5;
  }

  /*
   * Image available.
   */
  if (
    article.image_url
  ) {
    score += 3;
  }

  /*
   * Known/recognized source.
   */
  if (
    isRecognizedSource(source)
  ) {
    score += 5;
  }

  /*
   * Very recent news gets priority.
   */
  score += freshnessScore(
    article.published_at
  );

  return Number(
    score.toFixed(2)
  );
}


/*
 * Freshness score.
 */
function freshnessScore(
  publishedAt
) {

  const timestamp =
    new Date(
      publishedAt
    ).getTime();

  if (
    !Number.isFinite(timestamp)
  ) {
    return 0;
  }

  const ageHours =
    Math.max(
      0,
      (Date.now() - timestamp) /
      (1000 * 60 * 60)
    );

  if (ageHours <= 1) {
    return 10;
  }

  if (ageHours <= 3) {
    return 8;
  }

  if (ageHours <= 6) {
    return 6;
  }

  if (ageHours <= 12) {
    return 4;
  }

  if (ageHours <= 24) {
    return 2;
  }

  return 0;
}


/*
 * Basic recognized-source list.
 *
 * This is only a preliminary quality signal.
 * It does NOT mean other sources are automatically bad.
 */
function isRecognizedSource(
  source
) {

  const value =
    source.toLowerCase();

  const trustedPatterns = [
    "reuters",
    "associated press",
    "bbc",
    "the hindu",
    "hindustan times",
    "indian express",
    "times of india",
    "ndtv",
    "news18",
    "aaj tak",
    "india today",
    "economic times",
    "business standard",
    "livemint"
  ];

  return trustedPatterns.some(
    pattern =>
      value.includes(pattern)
  );
}


/*
 * Category balancing.
 *
 * Maximum 25 articles.
 *
 * We first take the highest scoring article
 * from each category, then fill the remaining
 * slots according to score.
 */
function selectWithCategoryBalance(
  articles,
  limit
) {

  const selected = [];

  const categoryCount =
    new Map();

  /*
   * First pass:
   * Give every category a chance.
   */
  for (const article of articles) {

    if (
      selected.length >= limit
    ) {
      break;
    }

    const category =
      article.category ||
      "general";

    const count =
      categoryCount.get(category) || 0;

    /*
     * At first, allow maximum 4 stories
     * from the same category.
     */
    if (count >= 4) {
      continue;
    }

    selected.push(article);

    categoryCount.set(
      category,
      count + 1
    );
  }

  /*
   * Second pass:
   * Fill remaining slots with highest
   * scoring articles.
   */
  if (
    selected.length < limit
  ) {

    const selectedIds =
      new Set(
        selected.map(
          article => article.id
        )
      );

    for (
      const article of articles
    ) {

      if (
        selected.length >= limit
      ) {
        break;
      }

      if (
        selectedIds.has(article.id)
      ) {
        continue;
      }

      selected.push(article);

      selectedIds.add(
        article.id
      );
    }
  }

  return selected.slice(
    0,
    limit
  );
}


/*
 * Publish selected news.
 *
 * Gemini processing will happen BEFORE this
 * function is called.
 */
export async function publishSelectedNews(
  db,
  selectedArticles,
  geminiResults
) {

  if (
    !Array.isArray(selectedArticles)
  ) {
    return {
      published: 0
    };
  }

  if (
    !Array.isArray(geminiResults)
  ) {
    return {
      published: 0
    };
  }

  const geminiMap =
    new Map();

  for (
    const result of geminiResults
  ) {

    if (!result?.id) {
      continue;
    }

    geminiMap.set(
      result.id,
      result
    );
  }

  let published = 0;

  for (
    const article of selectedArticles
  ) {

    const generated =
      geminiMap.get(
        article.id
      );

    /*
     * Never publish a story if Gemini did not
     * return a valid result.
     */
    if (
      !generated ||
      !generated.headline ||
      !generated.summary
    ) {
      continue;
    }

    await publishNews(
      db,
      article.id,
      {
        headline:
          generated.headline,

        summary:
          generated.summary,

        main_topic:
          generated.main_topic ||
          article.main_topic ||
          article.category,

        score:
          article.score
      }
    );

    published++;
  }

  return {
    published
  };
}


/*
 * Remove excessive records.
 *
 * The final database limit is 200.
 *
 * Oldest records are deleted first.
 */
export async function enforceStorageLimit(
  db,
  getCount,
  deleteOldest
) {

  let count =
    await getCount(db);

  while (
    count > MAX_TOTAL_NEWS
  ) {

    await deleteOldest(db);

    count--;
  }

  return count;
}


/*
 * Export constants for use by index.js
 * and the scheduled news pipeline.
 */
export {
  MAX_DAILY_NEWS,
  MAX_TOTAL_NEWS
};