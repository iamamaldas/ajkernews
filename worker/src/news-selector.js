/*
 * News selector — Strict Gemini-only
 * 3 bn + 3 en = 6 news per slot (target 4-6)
 * Last 80 news dedup
 */

import { publishNews } from "./database.js";
import { normalizeText } from "./utils.js";

const MAX_NEWS_PER_SLOT = 6;
const MAX_PER_LANGUAGE = 3;
const SIMILARITY_THRESHOLD = 0.55;

export function selectBestCandidates(candidates, existingPublished = []) {
  if (!Array.isArray(candidates)) return [];

  const bnCandidates = candidates.filter(c => c.language === "bn");
  const enCandidates = candidates.filter(c => c.language === "en");

  const bnGrouped = groupSimilarStories(bnCandidates);
  const enGrouped = groupSimilarStories(enCandidates);

  const bnSelected = selectTopFromLanguage(bnGrouped, existingPublished, MAX_PER_LANGUAGE);
  const enSelected = selectTopFromLanguage(enGrouped, existingPublished, MAX_PER_LANGUAGE);

  const combined = [...bnSelected, ...enSelected];

  console.log(
    `[SELECT] input bn=${bnCandidates.length} en=${enCandidates.length} | selected bn=${bnSelected.length} en=${enSelected.length} total=${combined.length}`
  );

  return combined.slice(0, MAX_NEWS_PER_SLOT);
}

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
      groups.push({ primary: article, sources: [article] });
    }
  }

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
    return { ...primary, additional_sources };
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
    if (!title || title.length < 3) {
      accepted.push(article);
      continue;
    }

    let duplicate = false;
    for (const oldArticle of existing) {
      const oldTitle = normalizeTitle(oldArticle.source_title || oldArticle.headline);
      if (oldTitle && oldTitle.length >= 3 && areSimilarStories(title, oldTitle)) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    for (const selected of accepted) {
      const selectedTitle = normalizeTitle(selected.source_title);
      if (selectedTitle && selectedTitle.length >= 3 && areSimilarStories(title, selectedTitle)) {
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
  return normalizeText(String(title || ""))
    .split(/\s+/)
    .filter(word => word.length >= 4)
    .filter(word => !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this",
  "have", "has", "will", "into", "after", "before",
  "about", "over", "under", "says", "said", "new", "news",
  "india", "today", "bengal", "west", "kolkata",
  "এই", "এবং", "ও", "বা", "কিন্তু", "তবে", "যে", "যা", "হয়",
  "হয়েছে", "হয়েছেন", "করে", "করেছে", "করেছেন", "জন্য", "থেকে",
  "সাথে", "মধ্যে", "উপর", "নিচে", "আগে", "পরে", "আজ", "কাল",
  "খবর", "সংবাদ", "জানিয়েছেন", "জানানো", "বলেন", "বলেছেন"
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
  return (common / smaller) >= SIMILARITY_THRESHOLD;
}

function calculateQualityScore(article) {
  let score = Number(article.score || 0);
  const title = String(article.source_title || "").trim();
  const description = String(article.source_description || "").trim();
  const source = String(article.source_name || "").trim();

  if (title.length >= 35 && title.length <= 180) score += 5;
  if (description.length >= 200) score += 8;
  else if (description.length >= 100) score += 4;
  if (article.image_url) score += 3;
  if (isRecognizedSource(source)) score += 15;
  if (Array.isArray(article.additional_sources) && article.additional_sources.length) {
    score += article.additional_sources.length * 3;
  }

  const combined = (title + " " + description).toLowerCase();
  if (combined.includes("breaking") || combined.includes("viral") || combined.includes("trending") || combined.includes("big")) {
    score += 10;
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
    "abp", "anandabazar", "bartaman", "ei samay", "sangbad pratidin",
    "tv9 bangla", "zee 24 ghanta", "kolkata tv", "news18 bangla",
    "republic bangla", "abp ananda",
    "aaj tak", "ndtv", "times of india", "hindustan times",
    "indian express", "the hindu", "news18", "india today",
    "economic times", "livemint", "business standard", "zee news",
    "republic", "firstpost", "the wire", "scroll", "telegraph india",
    "reuters", "associated press", "ap news", "bbc", "cnn",
    "al jazeera", "the guardian", "new york times", "washington post",
    "bloomberg", "forbes"
  ];
  return trustedPatterns.some(pattern => value.includes(pattern));
}

function selectWithCategoryBalance(articles, limit) {
  const selected = [];
  const categoryCount = new Map();
  const maxPerCategory = limit <= 3 ? limit : 3;

  for (const article of articles) {
    if (selected.length >= limit) break;
    const category = article.category || "general";
    const count = categoryCount.get(category) || 0;
    if (count >= maxPerCategory) continue;
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
 * Publish — STRICT Gemini-only (no fallback)
 * ========================================================= */
export async function publishSelectedNews(db, selectedArticles, geminiResults) {
  if (!Array.isArray(selectedArticles)) return { published: 0, skipped: 0 };

  const geminiMap = new Map();
  for (const result of (geminiResults || [])) {
    if (!result?.id) continue;
    geminiMap.set(String(result.id), result);
  }

  let published = 0;
  let skipped = 0;

  for (const article of selectedArticles) {
    const generated = geminiMap.get(String(article.id));

    if (!generated || !generated.headline || !generated.summary) {
      console.warn(`[SKIP] No Gemini result for ${article.id}`);
      skipped++;
      continue;
    }

    const headline = cleanText(generated.headline);
    const summary = cleanText(generated.summary);
    const mainTopic = generated.main_topic || article.main_topic || article.category || "general";

    if (!headline || headline.length < 20) {
      console.warn(`[SKIP] Gemini headline too short for ${article.id}`);
      skipped++;
      continue;
    }
    if (!summary || summary.length < 80) {
      console.warn(`[SKIP] Gemini summary too short for ${article.id}`);
      skipped++;
      continue;
    }
    const isBangla = /[\u0980-\u09FF]/.test(headline + " " + summary);
    if (!isBangla) {
      console.warn(`[SKIP] Gemini not Bangla for ${article.id}`);
      skipped++;
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
      console.log(`[PUBLISH OK] ${article.id} — ${headline.slice(0, 60)}`);
    } catch (error) {
      console.error(`[PUBLISH FAIL] ${article.id}:`, error?.message || String(error));
      skipped++;
    }
  }

  console.log(`[PUBLISH] ${published} published, ${skipped} skipped`);
  return { published, skipped };
}

function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export { MAX_NEWS_PER_SLOT, MAX_PER_LANGUAGE };
