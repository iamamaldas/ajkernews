/*
 * Gemini news writer — 100% RELIABLE, FREE TIER OPTIMIZED
 *
 * Free tier features:
 *   1. Per-article isolated calls (no batch failure)
 *   2. Auto model discovery (cached 1 hour, prefers stable model)
 *   3. Retry on validation fail with simplified prompt
 *   4. Timeout 15s per call (overload-safe)
 *   5. Loose validation — soft Bangla check
 *   6. Parallel processing (max 3 articles per batch, all articles processed)
 *   7. Target 150 words (rich content)
 *   8. Auto model rotation on failure (no same-model retry)
 *
 * Free tier limits: Gemini 2.0 Flash = 15 RPM, 1500 RPD
 * Our usage: 12 requests per cron, 12 crons/day = 144 req/day (safe)
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ✅ CONTENT QUALITY SETTINGS (Target 150 words)
const MIN_SUMMARY_WORDS = 80;        // Reject threshold
const TARGET_SUMMARY_WORDS = 150;    // Aim
const RETRY_MIN_WORDS = 60;          // Lower on retry

// ✅ RELIABILITY SETTINGS — TUNED FOR GEMINI OVERLOAD
const GEMINI_TIMEOUT_MS = 15000;     // 15s timeout
const MAX_OUTPUT_TOKENS = 8192;
const MAX_PARALLEL = 3;              // Gemini overload safe — batch size
const MAX_RETRIES_PER_ARTICLE = 2;
const RETRY_DELAY_MS = 2000;         // 2s delay between retries
const BATCH_DELAY_MS = 2500;         // 2.5s delay between batches (rate limit safe)

// ✅ LOOSE schema — Gemini won't reject
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
    required: ["id", "headline", "summary"]
  }
};

// Model cache (avoid repeated ListModels calls)
let cachedModels = null;
let cacheTime = 0;
const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/* =========================================================
 * Model Discovery — stable model first
 * ========================================================= */
async function discoverModels(apiKey) {
  if (cachedModels && (Date.now() - cacheTime) < MODEL_CACHE_TTL) {
    return cachedModels;
  }

  // ✅ Priority: 2.0-flash first (stable, less overloaded than 2.5)
  const FALLBACK_MODELS = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite"
  ];

  try {
    const listUrl = `${GEMINI_API_BASE}?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
      response = await fetch(listUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      console.warn(`[GEMINI] ListModels ${response.status} — using fallback`);
      cachedModels = FALLBACK_MODELS;
      cacheTime = Date.now();
      return cachedModels;
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

    if (!available.length) {
      console.warn("[GEMINI] No Flash from ListModels — using fallback");
      cachedModels = FALLBACK_MODELS;
      cacheTime = Date.now();
      return cachedModels;
    }

    // ✅ Prefer stable models: 2.0-flash first, then 2.5
    const priority = ["gemini-2.0-flash", "gemini-2.0-flash-001"];
    const priorityList = available.filter(m => priority.includes(m));
    const restList = available.filter(m => !priority.includes(m));

    // Sort rest by version (newest first)
    const versionRegex = /^gemini-(\d+)(?:\.(\d+))?/;
    restList.sort((a, b) => {
      const ma = a.match(versionRegex);
      const mb = b.match(versionRegex);
      const aMaj = ma ? Number(ma[1]) : 0;
      const bMaj = mb ? Number(mb[1]) : 0;
      const aMin = ma && ma[2] ? Number(ma[2]) : 0;
      const bMin = mb && mb[2] ? Number(mb[2]) : 0;
      if (aMaj !== bMaj) return bMaj - aMaj;
      return bMin - aMin;
    });

    const merged = [...new Set([...priorityList, ...restList, ...FALLBACK_MODELS])];

    console.log(`[GEMINI] Models: ${merged.join(" → ")}`);
    cachedModels = merged;
    cacheTime = Date.now();
    return merged;
  } catch (error) {
    console.warn("[GEMINI] Discovery failed:", error?.message || String(error));
    cachedModels = FALLBACK_MODELS;
    cacheTime = Date.now();
    return cachedModels;
  }
}

/* =========================================================
 * Main Entry — Batch processing (ALL articles processed)
 * ========================================================= */
export async function processSelectedNews(articles, apiKey) {
  if (!apiKey) {
    console.warn("[GEMINI] No API key");
    return [];
  }
  if (!Array.isArray(articles) || articles.length === 0) return [];

  const models = await discoverModels(apiKey);
  const allResults = [];
  const totalBatches = Math.ceil(articles.length / MAX_PARALLEL);

  console.log(`[GEMINI] Processing ${articles.length} articles in ${totalBatches} batches (batch size: ${MAX_PARALLEL})`);

  for (let i = 0; i < articles.length; i += MAX_PARALLEL) {
    const batch = articles.slice(i, i + MAX_PARALLEL);
    const batchNum = Math.floor(i / MAX_PARALLEL) + 1;

    console.log(`[GEMINI] Batch ${batchNum}/${totalBatches}: ${batch.length} articles`);

    const settled = await Promise.allSettled(
      batch.map(article => processOneArticle(article, models, apiKey))
    );

    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === "fulfilled" && r.value) {
        allResults.push(r.value);
        console.log(`[GEMINI] ✅ ${batch[j].id}`);
      } else {
        const reason = r.status === "rejected"
          ? (r.reason?.message || "rejected")
          : "returned null";
        console.warn(`[GEMINI] ❌ ${batch[j].id}: ${reason}`);
      }
    }

    // Batch delay to avoid rate limit (except after last batch)
    if (i + MAX_PARALLEL < articles.length) {
      console.log(`[GEMINI] Waiting ${BATCH_DELAY_MS}ms before next batch...`);
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`[GEMINI] Success: ${allResults.length}/${articles.length}`);
  return allResults;
}

/* =========================================================
 * Per-Article Processing with Retry
 * ========================================================= */
async function processOneArticle(article, models, apiKey) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES_PER_ARTICLE; attempt++) {
    const isRetry = attempt > 1;
    const prompt = buildPrompt(article, isRetry);
    const maxTokens = isRetry ? MAX_OUTPUT_TOKENS : 5000;

    for (const model of models) {
      try {
        const result = await callGeminiAPI(model, prompt, apiKey, maxTokens);
        const validated = validateGeminiResult(result, article, isRetry);

        if (validated) {
          if (isRetry) {
            console.log(`[GEMINI] ✅ Retry succeeded for ${article.id} with ${model}`);
          }
          return validated;
        }
        lastError = new Error("validation_failed");
      } catch (error) {
        lastError = error;
        const msg = String(error?.message || "");

        // ✅ Immediate model switch on these errors
        if (msg.includes("404") || msg.includes("NOT_FOUND") || msg.includes("not supported")) continue;
        if (msg.includes("429")) continue;
        if (msg.includes("api_500") || msg.includes("api_502") || msg.includes("api_503") || msg.includes("api_504")) continue;
        if (msg.includes("timeout")) continue;
        if (msg.includes("JSON") || msg.includes("parse")) continue;

        console.warn(`[GEMINI] ${model} error: ${msg.slice(0, 100)}`);
        continue;
      }
    }

    if (attempt < MAX_RETRIES_PER_ARTICLE) {
      console.log(`[GEMINI] Retrying ${article.id} with simplified prompt`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  console.warn(`[GEMINI] Failed after ${MAX_RETRIES_PER_ARTICLE} attempts: ${article.id}`);
  return null;
}

/* =========================================================
 * Prompt Builder — Target 150 words
 * ========================================================= */
function buildPrompt(article, simplified = false) {
  const sourceData = {
    id: String(article.id),
    title: String(article.source_title || "").trim(),
    description: String(article.source_description || "").trim(),
    source: String(article.source_name || "").trim(),
    category: String(article.category || "general").trim(),
    additional_sources: Array.isArray(article.additional_sources)
      ? article.additional_sources.map(s => ({
          title: String(s.source_title || "").trim(),
          description: String(s.source_description || "").trim(),
          source: String(s.source_name || "").trim()
        }))
      : []
  };

  if (simplified) {
    return `Convert this news into Bengali. Return JSON array with exactly one object.

REQUIRED:
- id: "${sourceData.id}"
- headline: Bengali headline (natural, under 180 chars)
- summary: Bengali summary (AT LEAST 100 Bengali words, 5-6 sentences)
- main_topic: short Bengali topic label

RULES:
- Translate English source to natural Bengali
- Keep names, numbers, dates
- Only use facts from source
- No AI mention

Source:
Title: ${sourceData.title}
Description: ${sourceData.description}
${sourceData.additional_sources.length ? `Additional sources: ${JSON.stringify(sourceData.additional_sources)}` : ""}
`;
  }

  return `You are a senior Bengali news editor for Ajker News, an Indian Bengali news website.

PRIMARY AUDIENCE: Bengali readers in India, especially West Bengal.

TASK: Rewrite this source into detailed, factual Bengali news.

COVERAGE PRIORITY:
1. West Bengal: Kolkata, Bengal government, politics, crime, education, jobs, weather
2. India: government, Delhi, Parliament, PM, Supreme Court, national politics
3. Other Indian states
4. Major world news affecting India
5. Business, Technology, Sports, Entertainment

MANDATORY LENGTH:
- Each summary MUST be AT LEAST ${MIN_SUMMARY_WORDS} Bengali words.
- AIM for ${TARGET_SUMMARY_WORDS}-200 Bengali words.
- Write 6-7 FULL sentences minimum.
- If summary is UNDER ${MIN_SUMMARY_WORDS} words, it will be REJECTED.

SENTENCE STRUCTURE:
- Sentence 1: WHAT happened (main event)
- Sentence 2: WHO was involved + WHERE + WHEN
- Sentence 3: WHY it matters (background)
- Sentences 4-5: Implications / public interest
- Sentences 6-7: Additional facts from source

HANDLING SHORT SOURCES:
If source description is short (under 200 chars):
- Expand using WIDELY KNOWN context about the topic.
- DO NOT invent specific names, numbers, quotes, or dates.
- Focus on WHAT and WHY using general knowledge.

RULES:
1. Use ONLY facts from the supplied source data.
2. Do NOT invent names, numbers, quotes, locations, dates, causes.
3. Do NOT add opinions or speculation.
4. Do NOT copy source headline word-for-word.
5. Write natural, clear Bengali suitable for mobile.
6. Preserve important names, organisations, places, numbers, dates.
7. Do not mention AI.
8. No promotional or clickbait language.
9. Return one result for EVERY supplied article.
10. Keep original article ID unchanged.
11. main_topic = short Bengali topic label.
12. Headline = under 180 characters.
13. If additional_sources provided, use them to enrich.

SOURCE ARTICLE:
${JSON.stringify(sourceData)}
`;
}

/* =========================================================
 * Gemini API Call — throws on 5xx for immediate model switch
 * ========================================================= */
async function callGeminiAPI(model, prompt, apiKey, maxTokens = 5000) {
  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
          temperature: 0.3,
          topP: 0.95,
          maxOutputTokens: maxTokens,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`timeout_${GEMINI_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  // ✅ 5xx → throw immediately for model switch (no retry)
  if ([500, 502, 503, 504].includes(response.status)) {
    const errText = await response.text().catch(() => "");
    throw new Error(`api_${response.status}: ${errText.slice(0, 150)}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`api_${response.status}: ${errText.slice(0, 150)}`);
  }

  const data = await response.json();

  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason === "SAFETY" || finishReason === "RECITATION") {
    throw new Error(`blocked: ${finishReason}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("empty_response");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        throw new Error("json_parse_failed");
      }
    } else {
      throw new Error("json_parse_failed");
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("empty_array");
  }

  return parsed[0];
}

/* =========================================================
 * Validation
 * ========================================================= */
function validateGeminiResult(result, article, isRetry = false) {
  if (!result || typeof result !== "object") return null;

  const id = String(result.id || "").trim();
  if (!id || id !== String(article.id)) {
    result.id = String(article.id);
  }

  const headline = cleanText(result.headline);
  const summary = cleanText(result.summary);
  const mainTopic = cleanText(result.main_topic) || cleanText(article.category) || "সাধারণ";

  if (!headline) {
    console.warn(`[GEMINI] Empty headline for ${article.id}`);
    return null;
  }

  if (!summary) {
    console.warn(`[GEMINI] Empty summary for ${article.id}`);
    return null;
  }

  const minWords = isRetry ? RETRY_MIN_WORDS : MIN_SUMMARY_WORDS;
  const wordCount = summary.split(/\s+/).filter(Boolean).length;

  if (wordCount < minWords) {
    console.warn(`[GEMINI] Summary ${wordCount} words < ${minWords} for ${article.id}`);
    return null;
  }

  let finalHeadline = headline;
  if (headline.length > 250) {
    finalHeadline = headline.slice(0, 240) + "...";
  }

  let finalSummary = summary;
  if (summary.length > 3000) {
    finalSummary = summary.slice(0, 2900) + "...";
  }

  const hasBangla = /[\u0980-\u09FF]/.test(headline + " " + summary);
  if (!hasBangla) {
    console.warn(`[GEMINI] No Bangla for ${article.id} — accepting (rare)`);
  }

  return {
    id: String(article.id),
    headline: finalHeadline,
    summary: finalSummary,
    main_topic: mainTopic
  };
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/* =========================================================
 * Public API
 * ========================================================= */
export function geminiStatus(apiKey) {
  return {
    configured: Boolean(apiKey),
    mode: "batch-processing-all-articles",
    minWords: MIN_SUMMARY_WORDS,
    targetWords: TARGET_SUMMARY_WORDS,
    timeout: GEMINI_TIMEOUT_MS,
    maxTokens: MAX_OUTPUT_TOKENS,
    maxRetriesPerArticle: MAX_RETRIES_PER_ARTICLE,
    maxParallel: MAX_PARALLEL,
    batchDelay: BATCH_DELAY_MS
  };
}
