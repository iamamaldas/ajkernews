/*
 * Gemini news writer — FULLY AUTOMATIC (Content Quality Optimized)
 *
 * - Auto-discovers Flash models
 * - 80 words minimum (Free Tier Safe)
 * - 5-7 sentence structure
 * - Widely known context expansion (no invention)
 * - 20s timeout per model (Cloudflare Worker Safe)
 * - ✅ Single batch processing (no chunking) — Worker timeout safe
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ✅ Content Quality Optimized
const MIN_SUMMARY_WORDS = 80;
const TARGET_SUMMARY_WORDS = 130;

const MAX_RETRIES_5XX = 1;
const RETRY_DELAY_5XX_MS = 1500;
const GEMINI_TIMEOUT_MS = 20000; // ✅ 20s (Cloudflare Worker Safe)

// ✅ FIX: maxOutputTokens lowered to 4000 (Gemini Flash max is 8192, was 16000 → silent truncate)
const MAX_OUTPUT_TOKENS = 4000;

const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      headline: { type: "STRING" },
      summary: { type: "STRING" },
      main_topic: { type: "STRING" }
    },
    required: ["id", "headline", "summary", "main_topic"]
  }
};

/* =========================================================
 * Model Discovery
 * ========================================================= */
async function discoverModels(apiKey) {
  const listUrl = `${GEMINI_API_BASE}?key=${encodeURIComponent(apiKey)}`;

  console.log("[AUTO] Discovering Gemini Flash models...");

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES_5XX; attempt++) {
    try {
      const response = await fetch(listUrl, {
        method: "GET",
        headers: { accept: "application/json" }
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        if ([500, 502, 503, 504].includes(response.status)) {
          lastError = new Error(`ListModels API ${response.status}: ${errText}`);
          if (attempt < MAX_RETRIES_5XX) {
            await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
            continue;
          }
          throw lastError;
        }
        throw new Error(`ListModels API ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const allModels = Array.isArray(data?.models) ? data.models : [];
      if (!allModels.length) throw new Error("ListModels returned no models.");

      const availableModels = allModels
        .map(m => {
          const name = String(m?.name || "").replace(/^models\//, "");
          const methods = Array.isArray(m?.supportedGenerationMethods)
            ? m.supportedGenerationMethods
            : [];
          return { name, methods };
        })
        .filter(m => m.name.includes("flash"))
        .filter(m => m.methods.includes("generateContent"))
        .filter(m => /^gemini-\d/.test(m.name))
        .map(m => m.name);

      if (!availableModels.length) throw new Error("No Flash models available.");

      console.log(`[AUTO] Available Flash models: ${availableModels.join(", ")}`);

      const versionRegex = /^gemini-(\d+)(?:\.(\d+))?/;
      availableModels.sort((a, b) => {
        const ma = a.match(versionRegex);
        const mb = b.match(versionRegex);
        const aMaj = ma ? Number(ma[1]) : 0;
        const bMaj = mb ? Number(mb[1]) : 0;
        const aMin = ma && ma[2] ? Number(ma[2]) : 0;
        const bMin = mb && mb[2] ? Number(mb[2]) : 0;
        if (aMaj !== bMaj) return bMaj - aMaj;
        return bMin - aMin;
      });

      console.log(`[AUTO] Priority order: ${availableModels.join(" → ")}`);
      return availableModels;

    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES_5XX) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Model discovery failed after retries");
}

/* =========================================================
 * Main Entry — ✅ SINGLE BATCH (no chunking)
 * ========================================================= */
export async function generateNewsWithGemini(articles, apiKey) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (!Array.isArray(articles) || articles.length === 0) return [];

  const models = await discoverModels(apiKey);

  // ✅ FIX: Single batch — Cloudflare Worker 25s timeout safe
  // আগে 2 batch ছিল, প্রতিটা 20s → 40s+ → Promise.race reject → সব English fallback
  console.log(`[GEMINI] Single batch: ${articles.length} articles`);
  const results = await processBatch(articles, models, apiKey);

  return validateAndCleanResults(results || [], articles);
}

async function processBatch(articles, models, apiKey) {
  const sourceArticles = articles.map(article => ({
    id: String(article.id),
    title: String(article.source_title || "").trim(),
    description: String(article.source_description || "").trim(),
    source: String(article.source_name || "").trim(),
    published_at: String(article.published_at || "").trim(),
    category: String(article.category || "general").trim(),
    language: String(article.language || "en").trim(),
    additional_sources: Array.isArray(article.additional_sources)
      ? article.additional_sources.map(s => ({
          title: String(s.source_title || "").trim(),
          description: String(s.source_description || "").trim(),
          source: String(s.source_name || "").trim()
        }))
      : []
  }));

  const prompt = buildPrompt(sourceArticles);

  let lastError = null;

  for (const model of models) {
    try {
      console.log(`[MODEL] Trying ${model} with ${articles.length} articles...`);
      const results = await callGeminiAPI(model, prompt, apiKey);

      if (Array.isArray(results) && results.length > 0) {
        console.log(`[MODEL] ✅ ${model} succeeded (${results.length} results)`);
        return results;
      }

      console.warn(`[MODEL] ${model} returned empty results`);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || "");

      if (msg.includes("429")) {
        console.warn(`[MODEL] ${model} quota exceeded`);
        continue;
      }
      if (msg.includes("404") || msg.includes("NOT_FOUND")) {
        console.warn(`[MODEL] ${model} retired`);
        continue;
      }
      if (msg.includes("503") || msg.includes("500") || msg.includes("502") || msg.includes("504")) {
        console.warn(`[MODEL] ${model} server error`);
        continue;
      }
      if (msg.includes("timeout")) {
        console.warn(`[MODEL] ${model} timed out`);
        continue;
      }

      console.error(`[MODEL] ${model} failed:`, msg);
      continue;
    }
  }

  console.warn(`[BATCH] All models failed for batch of ${articles.length}`);
  return [];
}

/* =========================================================
 * Prompt Builder
 * ========================================================= */
function buildPrompt(sourceArticles) {
  return `You are the senior Bengali news editor for Ajker News, an Indian Bengali news website.

PRIMARY AUDIENCE: Bengali readers in India, especially West Bengal.

TASK: Rewrite the supplied source information into detailed, factual Bengali news.

LANGUAGE: Some sources are in English. You MUST translate and rewrite them into natural Bengali.

=========================================================
COVERAGE PRIORITY:
=========================================================
1. West Bengal: Kolkata, Bengal government, Bengal politics, Bengal crime, Bengal development, Bengal education, Bengal jobs, Bengal weather, Bengal public-interest news.
2. India: Indian government, Delhi, Parliament, Prime Minister, Supreme Court, national politics, economy, jobs, education, public-interest events.
3. Other Indian states.
4. Major world news affecting India.
5. Business, Technology, Sports, Entertainment.

=========================================================
CRITICAL LENGTH REQUIREMENT:
=========================================================
- Each summary MUST be AT LEAST ${MIN_SUMMARY_WORDS} Bengali words.
- AIM for ${TARGET_SUMMARY_WORDS}-180 Bengali words per summary.
- Write 5-7 FULL sentences minimum.
- If a summary is UNDER ${MIN_SUMMARY_WORDS} words, it will be REJECTED.

=========================================================
SENTENCE STRUCTURE (MANDATORY):
=========================================================
Follow this structure exactly:
- Sentence 1: WHAT happened (main event)
- Sentence 2: WHO was involved + WHERE + WHEN (if available in source)
- Sentence 3: WHY it matters (background context)
- Sentence 4-5: Implications / public interest angle
- Sentence 6-7: Additional facts from source

=========================================================
HANDLING SHORT SOURCES:
=========================================================
If the source description is short (under 200 characters):
- Expand using WIDELY KNOWN context about the topic.
- DO NOT invent specific names, numbers, quotes, or dates.
- Focus on WHAT and WHY using general knowledge.
- Never fabricate details that are not in the source.

=========================================================
IMPORTANT RULES:
=========================================================
1. Use ONLY facts from the supplied source data.
2. Do NOT invent names, numbers, quotes, locations, dates, causes, reactions.
3. Do NOT add opinions or speculation.
4. Do NOT copy the source headline word-for-word.
5. Write natural, clear Bengali suitable for mobile.
6. Preserve important names, organisations, places, numbers, dates.
7. Do not mention AI.
8. No promotional or clickbait language.
9. Do not create facts merely to reach word count.
10. Return one result for EVERY supplied article.
11. Keep the original article ID unchanged.
12. main_topic = short Bengali topic label.
13. Headline = under 180 characters.
14. If "additional_sources" is provided, use them to enrich the story with more facts.

=========================================================
SOURCE ARTICLES:
=========================================================
${JSON.stringify(sourceArticles, null, 2)}
`;
}

/* =========================================================
 * Gemini API Call
 * ========================================================= */
async function callGeminiAPI(model, prompt, apiKey) {
  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES_5XX; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: "application/json",
              responseSchema: RESPONSE_SCHEMA,
              maxOutputTokens: MAX_OUTPUT_TOKENS   // ✅ FIX: 4000
            }
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) throw new Error("Gemini returned no text output.");

        let results;
        try {
          results = JSON.parse(text);
        } catch {
          throw new Error("Gemini returned invalid JSON.");
        }

        if (!Array.isArray(results)) {
          throw new Error("Gemini response is not an array.");
        }

        return results;
      }

      if ([500, 502, 503, 504].includes(response.status)) {
        const errText = await response.text().catch(() => "");
        lastError = new Error(`Gemini API ${response.status}: ${errText}`);

        if (attempt < MAX_RETRIES_5XX) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
          continue;
        }
        throw lastError;
      }

      const errText = await response.text().catch(() => "");
      throw new Error(`Gemini API ${response.status}: ${errText}`);

    } catch (error) {
      const msg = String(error?.message || "");

      if (error.name === "AbortError") {
        console.error(`[MODEL] ${model} timed out after ${GEMINI_TIMEOUT_MS}ms`);
        throw new Error(`Gemini timeout: ${model}`);
      }

      if (
        attempt < MAX_RETRIES_5XX &&
        !msg.includes("429") &&
        !msg.includes("404") &&
        !msg.includes("NOT_FOUND") &&
        !msg.includes("Gemini API") &&
        !msg.includes("invalid JSON") &&
        !msg.includes("not an array") &&
        !msg.includes("timeout")
      ) {
        lastError = error;
        await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Gemini call failed after retries");
}

/* =========================================================
 * Validation
 * ========================================================= */
function validateAndCleanResults(results, originalArticles) {
  return results
    .map(result => validateGeminiResult(result, originalArticles))
    .filter(Boolean);
}

function validateGeminiResult(result, originalArticles) {
  if (!result || typeof result !== "object") return null;

  const id = String(result.id || "").trim();
  if (!id) return null;

  const original = originalArticles.find(article => String(article.id) === id);
  if (!original) return null;

  const headline = cleanText(result.headline);
  const summary = cleanText(result.summary);
  const mainTopic = cleanText(result.main_topic);

  if (!headline || !summary || !mainTopic) return null;

  const wordCount = summary.split(/\s+/).filter(Boolean).length;

  if (wordCount < MIN_SUMMARY_WORDS) {
    console.warn(`[REJECT] Summary too short (${wordCount} words < ${MIN_SUMMARY_WORDS}) for ID ${id}`);
    return null;
  }

  if (headline.length > 180) return null;
  if (summary.length > 2500) return null;

  return { id, headline, summary, main_topic: mainTopic };
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/* =========================================================
 * Public API
 * ========================================================= */
export async function processSelectedNews(articles, apiKey) {
  if (!Array.isArray(articles) || articles.length === 0) return [];
  const limitedArticles = articles.slice(0, 4);
  return await generateNewsWithGemini(limitedArticles, apiKey);
}

export function geminiStatus(apiKey) {
  return {
    configured: Boolean(apiKey),
    mode: "fully-automatic-discovery-and-rotation",
    minWords: MIN_SUMMARY_WORDS,
    targetWords: TARGET_SUMMARY_WORDS
  };
}
