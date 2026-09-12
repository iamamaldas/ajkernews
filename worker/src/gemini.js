/*
 * Gemini news writer — auto-discovery + quota-aware rotation
 *
 * Strategy:
 * 1. Discover all available Flash models
 * 2. Order: high-quota models first, then newest
 * 3. Try each model in order
 * 4. On 429 (quota) → try next model
 * 5. On 5xx (server) → retry same model, then move on
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MIN_SUMMARY_WORDS = 150;
const TARGET_SUMMARY_WORDS = 180;

const MAX_RETRIES_5XX = 3;
const RETRY_DELAY_5XX_MS = 3000;

/*
 * High-quota models — preferred order.
 * These have RPD 500-1500 on free tier.
 */
const HIGH_QUOTA_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash"
];

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

/*
 * Discover all available Flash models, ordered by priority.
 */
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
          console.warn(`[RETRY ${attempt}/${MAX_RETRIES_5XX}] ListModels ${response.status}`);

          if (attempt < MAX_RETRIES_5XX) {
            await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
            continue;
          }
          throw lastError;
        }

        throw new Error(`ListModels API ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const models = Array.isArray(data?.models) ? data.models : [];

      if (!models.length) throw new Error("ListModels returned no models.");

      const availableModels = models
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

      if (!availableModels.length) {
        throw new Error("No Flash models available.");
      }

      console.log(`[AUTO] Available Flash models: ${availableModels.join(", ")}`);

      // Build priority order
      const ordered = [];

      // 1. High-quota first
      for (const preferred of HIGH_QUOTA_MODELS) {
        if (availableModels.includes(preferred) && !ordered.includes(preferred)) {
          ordered.push(preferred);
        }
      }

      // 2. Remaining models, newest first
      const remaining = availableModels.filter(m => !ordered.includes(m));
      remaining.sort((a, b) => {
        const ma = a.match(/^gemini-(\d+)\.(\d+)/);
        const mb = b.match(/^gemini-(\d+)\.(\d+)/);
        const aMaj = ma ? Number(ma[1]) : 0;
        const bMaj = mb ? Number(mb[1]) : 0;
        const aMin = ma ? Number(ma[2]) : 0;
        const bMin = mb ? Number(mb[2]) : 0;
        if (aMaj !== bMaj) return bMaj - aMaj;
        return bMin - aMin;
      });

      ordered.push(...remaining);

      console.log(`[AUTO] Model priority: ${ordered.join(" → ")}`);
      return ordered;

    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES_5XX) {
        console.warn(`[RETRY ${attempt}/${MAX_RETRIES_5XX}] Discovery failed: ${error.message}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Model discovery failed after retries");
}

export async function generateNewsWithGemini(articles, apiKey) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (!Array.isArray(articles) || articles.length === 0) return [];

  const models = await discoverModels(apiKey);

  const sourceArticles = articles.map(article => ({
    id: String(article.id),
    title: String(article.source_title || "").trim(),
    description: String(article.source_description || "").trim(),
    source: String(article.source_name || "").trim(),
    published_at: String(article.published_at || "").trim(),
    category: String(article.category || "general").trim(),
    language: String(article.language || "en").trim()
  }));

  const prompt = `
You are the senior Bengali news editor for Ajker News, an Indian Bengali news website.

PRIMARY AUDIENCE: Bengali readers in India, especially West Bengal.

Your task is to rewrite the supplied source information into detailed, factual Bengali news.

Note: Some sources are in English. You MUST translate and rewrite them into natural Bengali.

COVERAGE PRIORITY:
1. West Bengal: Kolkata, Bengal government, Bengal politics, Bengal crime, Bengal development, Bengal education, Bengal jobs, Bengal weather, Bengal public-interest news.
2. India: Indian government, Delhi, Parliament, Prime Minister, Supreme Court, national politics, economy, jobs, education, public-interest events.
3. Other Indian states.
4. Major world news affecting India.
5. Business, Technology, Sports, Entertainment.

CRITICAL LENGTH REQUIREMENT:
- Each summary MUST be AT LEAST ${MIN_SUMMARY_WORDS} Bengali words.
- AIM for ${TARGET_SUMMARY_WORDS}-220 Bengali words per summary.
- If a summary is UNDER ${MIN_SUMMARY_WORDS} words, it will be REJECTED.
- 180 Bengali words ≈ 900-1100 characters. Count carefully.
- Write full, detailed paragraphs. Do NOT stop early.
- Cover WHAT happened, WHO was involved, WHERE, WHEN, WHY it matters, and BACKGROUND context.
- Add relevant context, implications, and public interest angle.

IMPORTANT RULES:
1. Use ONLY facts contained in the supplied source data.
2. Do NOT invent names, numbers, quotes, locations, dates, causes, reactions or other details.
3. Do NOT add opinions or speculation.
4. Do NOT copy the source headline word-for-word.
5. Write natural, clear Bengali suitable for a mobile news website.
6. Preserve important names, organisations, places, numbers and dates exactly when supported by the source.
7. Do not mention that AI was used.
8. Do not use promotional or clickbait language.
9. Do not create facts merely to reach a word count.
10. Return one result for every supplied article.
11. Keep the original article ID unchanged.
12. The main_topic should be a short Bengali topic label.
13. Headline should be concise (under 180 characters).

SOURCE ARTICLES:

${JSON.stringify(sourceArticles, null, 2)}
`;

  let lastError = null;

  /*
   * Try each model in priority order.
   * - 429 (quota) → move to next model immediately
   * - 5xx (server) → retry same model, then move on
   * - success → return results
   */
  for (const model of models) {
    try {
      console.log(`[MODEL] Trying ${model}...`);
      const results = await callGeminiAPI(model, prompt, apiKey);

      if (Array.isArray(results) && results.length > 0) {
        console.log(`[MODEL] ✅ ${model} succeeded`);
        return validateAndCleanResults(results, articles);
      }

      console.warn(`[MODEL] ${model} returned empty results`);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || "");

      if (msg.includes("429")) {
        console.warn(`[MODEL] ${model} quota exceeded — trying next model`);
        continue;
      }

      if (msg.includes("503") || msg.includes("500") || msg.includes("502") || msg.includes("504")) {
        console.warn(`[MODEL] ${model} server error — trying next model`);
        continue;
      }

      console.error(`[MODEL] ${model} failed:`, msg);
      continue;
    }
  }

  throw lastError || new Error("All models exhausted");
}

/*
 * Call a specific Gemini model.
 * Retries on 5xx (server overload).
 * Does NOT retry 429 (quota).
 */
async function callGeminiAPI(model, prompt, apiKey) {
  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES_5XX; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            maxOutputTokens: 16000
          }
        })
      });

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

      // 5xx → retry
      if ([500, 502, 503, 504].includes(response.status)) {
        const errText = await response.text().catch(() => "");
        lastError = new Error(`Gemini API ${response.status}: ${errText}`);

        console.warn(`[RETRY ${attempt}/${MAX_RETRIES_5XX}] ${model} ${response.status}`);

        if (attempt < MAX_RETRIES_5XX) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
          continue;
        }
        throw lastError;
      }

      // 429 or other → no retry (throw immediately)
      const errText = await response.text().catch(() => "");
      throw new Error(`Gemini API ${response.status}: ${errText}`);

    } catch (error) {
      const msg = String(error?.message || "");

      if (
        attempt < MAX_RETRIES_5XX &&
        !msg.includes("429") &&
        !msg.includes("Gemini API") &&
        !msg.includes("invalid JSON") &&
        !msg.includes("not an array")
      ) {
        console.warn(`[RETRY ${attempt}/${MAX_RETRIES_5XX}] Network error: ${msg}`);
        lastError = error;
        await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Gemini call failed after retries");
}

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

  if (wordCount < TARGET_SUMMARY_WORDS) {
    console.warn(`[BELOW TARGET] ${wordCount} words (target ${TARGET_SUMMARY_WORDS}) for ID ${id}`);
  }

  if (headline.length > 180) return null;
  if (summary.length > 2500) return null;

  return {
    id,
    headline,
    summary,
    main_topic: mainTopic
  };
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export async function processSelectedNews(articles, apiKey) {
  if (!Array.isArray(articles) || articles.length === 0) return [];
  const limitedArticles = articles.slice(0, 25);
  return await generateNewsWithGemini(limitedArticles, apiKey);
}

export function geminiStatus(apiKey) {
  return {
    configured: Boolean(apiKey),
    mode: "auto-discovery + quota-aware rotation",
    minWords: MIN_SUMMARY_WORDS,
    targetWords: TARGET_SUMMARY_WORDS
  };
}
