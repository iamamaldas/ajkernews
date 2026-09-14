/*
 * News selector — 2 bn + 2 en = 4 news per slot
 * + Group similar stories for better context
 */

import { publishNews } from "./database.js";
import { normalizeText } from "./utils.js";

const MAX_NEWS_PER_SLOT = 4;
const MAX_PER_LANGUAGE = 2;

export function selectBestCandidates(candidates, existingPublished = []) {
  if (!Array.isArray(candidates)) return [];

  const bnCandidates = candidates.filter(c => c.language === "bn");
  const enCandidates = candidates.filter(c => c.language === "en");

  // ✅ Group similar stories for richer context
  const bnGrouped = groupSimilarStories(bnCandidates);
  const enGrouped = groupSimilarStories(enCandidates);

  const bnSelected = selectTopFromLanguage(bnGrouped, existingPublished, MAX_PER_LANGUAGE);
  const enSelected = selectTopFromLanguage(enGrouped, existingPublished, MAX_PER_LANGUAGE);

  const combined = [...bnSelected, ...enSelected];

  console.log(
    `[SELECT] candidates bn=${bnCandidates.length} en=${enCandidates.length} | selected bn=${bnSelected.length} en=${enSelected.length}`
  );

  return combined.slice(0, MAX_NEWS_PER_SLOT);
}

/* =========================================================
 * Group Similar Stories — Multiple Sources
 * ========================================================= */
function groupSimilarStories(candidates) {
  if (!Array.isArray(candidates)) return [];

  const groups = [];

  for (const article of candidates) {
    const title = normalizeTitle(article.source_title);
    if (!title.length) continue;

    let foundGroup = null;

    for (const group of groups) {
      const groupTitle = normalizeTitle(group.primary.source_title);
      if (groupTitle.length && areSimilarStories(title, groupTitle)) {
        foundGroup = group;
        break;
      }
    }

    if (foundGroup) {
      foundGroup.sources.push(article);
    } else {
      groups.push({
        primary: article,
        sources: [article]
      });
    }
  }

  // ✅ প্রতিটি group থেকে সবচেয়ে বড় description-এর article primary
  return groups.map(group => {
    const sorted = group.sources.slice().sort((a, b) => {
      const aLen = (a.source_description || "").length;
      const bLen = (b.source_description || "").length;
      return bLen - aLen;
    });

    const primary = sorted[0];
    const additional_sources = sorted.slice(1, 3).map(s => ({
      source_title: s.source_title,
      source_description: s.source_description,
      source_name: s.source_name
    }));

    return {
      ...primary,
      additional_sources
    };
  });
}

function selectTopFromLanguage(candidates, existingPublished, limit) {
  const uniqueByUrl = removeDuplicateUrls(candidates);
  const uniqueStories = removeSimilarStories(uniqueByUrl, existingPublished);

  const scored = uniqueStories.map(article => ({
    ...article,
    score: calculateQualityScore(article)
  }));

  scored.sort((a, b) => b.score - a.score);

  return selectWithCategoryBalance(scored, limit);
}

function removeDuplicateUrls(articles) {
  const seen = new Set();
  const result = [];

  for (const article of articles) {
    const url = String(article.source_url || "").trim();
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(article);
  }

  return result;
}

function removeSimilarStories(candidates, existingPublished) {
  const accepted = [];
  const existing = Array.isArray(existingPublished) ? existingPublished : [];

  for (const article of candidates) {
    const title = normalizeTitle(article.source_title);
    if (!title) continue;

    let duplicate = false;

    for (const oldArticle of existing) {
      const oldTitle = normalizeTitle(oldArticle.source_title || oldArticle.headline);
      if (oldTitle && areSimilarStories(title, oldTitle)) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) continue;

    for (const selected of accepted) {
      const selectedTitle = normalizeTitle(selected.source_title);
      if (selectedTitle && areSimilarStories(title, selectedTitle)) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) continue;

    accepted.push(article);
  }

  return accepted;
}

function normalizeTitle(title = "") {
  return normalizeText(title)
    .split(/\s+/)
    .filter(word => word.length >= 3)
    .filter(word => !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this",
  "have", "has", "will", "into", "after", "before",
  "about", "over", "under", "says", "said", "new", "news",
  "india", "today", "bengal", "west", "kolkata"
]);

function areSimilarStories(wordsA, wordsB) {
  if (!wordsA.length || !wordsB.length) return false;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  let common = 0;
  for (const word of setA) {
    if (setB.has(word)) common++;
  }

  const smaller = Math.min(setA.size, setB.size);
  if (!smaller) return false;

  return (common / smaller) >= 0.60; // ✅ Lower for grouping
}

function calculateQualityScore(article) {
  let score = Number(article.score || 0);

  const title = String(article.source_title || "").trim();
  const description = String(article.source_description || "").trim();
  const source = String(article.source_name || "").trim();

  if (title.length >= 35 && title.length <= 180) score += 5;
  if (description.length >= 80) score += 5;
  if (article.image_url) score += 3;
  if (isRecognizedSource(source)) score += 5;
  if (Array.isArray(article.additional_sources) && article.additional_sources.length) {
    score += article.additional_sources.length * 3; // ✅ Multiple sources bonus
  }

  score += freshnessScore(article.published_at);

  return Number(score.toFixed(2));
}

function freshnessScore(publishedAt) {
  const timestamp = new Date(publishedAt).getTime();
  if (!Number.isFinite(timestamp)) return 0;

  const ageHours = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60));

  if (ageHours <= 1) return 10;
  if (ageHours <= 3) return 8;
  if (ageHours <= 6) return 6;
  if (ageHours <= 12) return 4;
  if (ageHours <= 24) return 2;
  return 0;
}

function isRecognizedSource(source) {
  const value = source.toLowerCase();
  const trustedPatterns = [
    "reuters", "associated press", "bbc", "the hindu", "hindustan times",
    "indian express", "times of india", "ndtv", "news18", "aaj tak",
    "india today", "economic times", "business standard", "livemint",
    "anandabazar", "bartaman", "abp", "ei samay", "sangbad pratidin"
  ];
  return trustedPatterns.some(pattern => value.includes(pattern));
}

function selectWithCategoryBalance(articles, limit) {
  const selected = [];
  const categoryCount = new Map();

  for (const article of articles) {
    if (selected.length >= limit) break;

    const category = article.category || "general";
    const count = categoryCount.get(category) || 0;

    if (count >= 2) continue;

    selected.push(article);
    categoryCount.set(category, count + 1);
  }

  if (selected.length < limit) {
    const selectedIds = new Set(selected.map(a => a.id));
    for (const article of articles) {
      if (selected.length >= limit) break;
      if (selectedIds.has(article.id)) continue;
      selected.push(article);
      selectedIds.add(article.id);
    }
  }

  return selected.slice(0, limit);
}

/* =========================================================
 * Publish — With Fallback
 * ========================================================= */
export async function publishSelectedNews(db, selectedArticles, geminiResults) {
  if (!Array.isArray(selectedArticles)) return { published: 0 };

  const geminiMap = new Map();
  for (const result of (geminiResults || [])) {
    if (!result?.id) continue;
    geminiMap.set(result.id, result);
  }

  let published = 0;

  for (const article of selectedArticles) {
    const generated = geminiMap.get(article.id);

    let headline, summary, mainTopic;

    if (generated && generated.headline && generated.summary) {
      // ✅ Gemini result
      headline = generated.headline;
      summary = generated.summary;
      mainTopic = generated.main_topic || article.main_topic || article.category || "general";
    } else {
      // ✅ Fallback: Gemini fail করলেও খবর publish হবে
      console.warn(`[FALLBACK] No Gemini result for ${article.id}, using source data`);
      headline = cleanText(article.source_title || article.headline || "সংবাদ");
      summary = cleanText(article.source_description || article.summary || "");
      mainTopic = article.category || "general";

      if (summary.length < 100) {
        summary = summary + `\n\nএই খবরটি ${article.source_name || 'সূত্র'} থেকে সংগ্রহ করা হয়েছে।`;
      }
    }

    if (!headline || !summary) {
      console.warn(`[SKIP] Missing headline/summary for ${article.id}`);
      continue;
    }

    try {
      await publishNews(db, article.id, {
        headline,
        summary,
        main_topic: mainTopic,
        score: article.score || 0
      });
      published++;
    } catch (error) {
      console.error(`[PUBLISH FAIL] ${article.id}:`, error?.message || String(error));
    }
  }

  console.log(`[PUBLISH] ${published}/${selectedArticles.length} published`);
  return { published };
}

function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export { MAX_NEWS_PER_SLOT, MAX_PER_LANGUAGE };
