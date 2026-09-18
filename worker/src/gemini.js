/*
 * Gemini news writer — PARALLEL INDIVIDUAL CALLS
 * Strict Gemini-only (no fallback)
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MIN_SUMMARY_WORDS = 80;
const TARGET_SUMMARY_WORDS = 130;

const MAX_RETRIES_5XX = 2;
const RETRY_DELAY_5XX_MS = 1500;
const GEMINI_TIMEOUT_MS = 18000;
const MAX_OUTPUT_TOKENS = 4000;
const MAX_PARALLEL = 6;

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

let cachedModels = null;
let cacheTime = 0;
const MODEL_CACHE_TTL = 60 * 60 * 1000;

async function discoverModels(apiKey) {
  if (cachedModels && (Date.now() - cacheTime) < MODEL_CACHE_TTL) {
    return cachedModels;
  }

  const listUrl = `${GEMINI_API_BASE}?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(listUrl, { method: "GET", headers: { accept: "application/json" } });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`ListModels ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const allModels = Array.isArray(data?.models) ? data.models : [];

  const available = allModels
    .map(m => ({
      name: String(m?.name || "").replace(/^models\//, ""),
      methods: Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : []
    }))
    .filter(m => m.name.includes("flash"))
    .filter(m => m.methods.includes("generateContent"))
    .filter(m => /^gemini-\d/.test(m.name))
    .map(m => m.name);

  if (!available.length) throw new Error("No Flash models available");

  const versionRegex = /^gemini-(\d+)(?:\.(\d+))?/;
  available.sort((a, b) => {
    const ma = a.match(versionRegex);
    const mb = b.match(versionRegex);
    const aMaj = ma ? Number(ma[1]) : 0;
    const bMaj = mb ? Number(mb[1]) : 0;
    const aMin = ma && ma[2] ? Number(ma[2]) : 0;
    const bMin = mb && mb[2] ? Number(mb[2]) : 0;
    if (aMaj !== bMaj) return bMaj - aMaj;
    return bMin - aMin;
  });

  console.log(`[GEMINI] Models: ${available.join(" → ")}`);
  cachedModels = available;
  cacheTime = Date.now();
  return available;
}

export async function processSelectedNews(articles, apiKey) {
  if (!apiKey) {
    console.warn("[GEMINI] No API key");
    return [];
  }
  if (!Array.isArray(articles) || articles.length === 0) return [];

  const limited = articles.slice(0, MAX_PARALLEL);
  console.log(`[GEMINI] Parallel processing ${limited.length} articles`);

  let models;
  try {
    models = await discoverModels(apiKey);
  } catch (error) {
    console.error("[GEMINI] Model discovery failed:", error?.message || String(error));
    return [];
  }

  const settled = await Promise.allSettled(
    limited.map(article => processOneArticle(article, models, apiKey))
  );

  const results = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled" && r.value) {
      results.push(r.value);
      console.log(`[GEMINI] ✅ ${limited[i].id}`);
    } else {
      console.warn(`[GEMINI] ❌ ${limited[i].id}: ${r.reason?.message || "failed"}`);
    }
  }

  console.log(`[GEMINI] Success: ${results.length}/${limited.length}`);
  return results;
}

async function processOneArticle(article, models, apiKey) {
  const sourceArticles = [{
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
  }];

  const prompt = buildPrompt(sourceArticles);

  for (const model of models) {
    try {
      const results = await callGeminiAPI(model, prompt, apiKey);
      if (Array.isArray(results) && results.length > 0) {
        return validateGeminiResult(results[0], article);
      }
    } catch (error) {
      const msg = String(error?.message || "");
      if (msg.includes("429") || msg.includes("404") || msg.includes("NOT_FOUND")) {
        continue;
      }
      console.warn(`[GEMINI] ${model} error: ${msg.slice(0, 100)}`);
      continue;
    }
  }

  return null;
}

function buildPrompt(sourceArticles) {
  return `You are a senior Bengali news editor for Ajker News.

TASK: Rewrite the supplied source into detailed, factual Bengali news.

LANGUAGE: Some sources are English. Translate and rewrite into natural Bengali.

LENGTH REQUIREMENT (MANDATORY):
- Each summary MUST be AT LEAST ${MIN_SUMMARY_WORDS} Bengali words.
- AIM for ${TARGET_SUMMARY_WORDS}-180 Bengali words.
- Write 5-7 FULL sentences minimum.
- If summary is UNDER ${MIN_SUMMARY_WORDS} words, it will be REJECTED.

SENTENCE STRUCTURE:
- Sentence 1: WHAT happened
- Sentence 2: WHO + WHERE + WHEN (if available)
- Sentence 3: WHY it matters
- Sentence 4-5: Implications / public interest
- Sentence 6-7: Additional facts from source

RULES:
1. Use ONLY facts from the supplied source data.
2. Do NOT invent names, numbers, quotes, locations, dates.
3. Do NOT add opinions or speculation.
4. Do NOT copy source headline word-for-word.
5. Write natural, clear Bengali.
6. Preserve important names, organisations, places, numbers, dates.
7. Do not mention AI.
8. No promotional or clickbait language.
9. Return one result for EVERY supplied article.
10. Keep original article ID unchanged.
11. main_topic = short Bengali topic label.
12. Headline = under 180 characters.
13. If "additional_sources" provided, use them to enrich.

SOURCE ARTICLES:
${JSON.stringify(sourceArticles, null, 2)}
`;
}

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
              maxOutputTokens: MAX_OUTPUT_TOKENS
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
        if (!text) throw new Error("No text output");

        let results;
        try {
          results = JSON.parse(text);
        } catch {
          throw new Error("Invalid JSON");
        }

        if (!Array.isArray(results)) throw new Error("Not an array");
        return results;
      }

      if ([500, 502, 503, 504].includes(response.status)) {
        const errText = await response.text().catch(() => "");
        lastError = new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
        if (attempt < MAX_RETRIES_5XX) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
          continue;
        }
        throw lastError;
      }

      const errText = await response.text().catch(() => "");
      throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);

    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Timeout after ${GEMINI_TIMEOUT_MS}ms`);
      }
      const msg = String(error?.message || "");
      if (attempt < MAX_RETRIES_5XX && !msg.includes("429") && !msg.includes("404") && !msg.includes("Invalid JSON")) {
        lastError = error;
        await new Promise(r => setTimeout(r, RETRY_DELAY_5XX_MS));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Gemini call failed");
}

function validateGeminiResult(result, originalArticle) {
  if (!result || typeof result !== "object") return null;

  const id = String(result.id || "").trim();
  if (!id) return null;

  if (String(originalArticle.id) !== id) return null;

  const headline = cleanText(result.headline);
  const summary = cleanText(result.summary);
  const mainTopic = cleanText(result.main_topic);

  if (!headline || !summary || !mainTopic) return null;

  const wordCount = summary.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_SUMMARY_WORDS) {
    console.warn(`[GEMINI] Reject: summary ${wordCount} words < ${MIN_SUMMARY_WORDS}`);
    return null;
  }

  if (headline.length > 180) return null;
  if (summary.length > 2500) return null;

  const isBangla = /[\u0980-\u09FF]/.test(headline + " " + summary);
  if (!isBangla) {
    console.warn(`[GEMINI] Reject: not Bangla`);
    return null;
  }

  return { id, headline, summary, main_topic: mainTopic };
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function geminiStatus(apiKey) {
  return {
    configured: Boolean(apiKey),
    mode: "parallel-individual-calls",
    minWords: MIN_SUMMARY_WORDS,
    targetWords: TARGET_SUMMARY_WORDS
  };
}
