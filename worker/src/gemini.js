/*
 * Gemini news writer — AUTO VERSION
 *
 * Purpose:
 * - Automatically discover the latest free-tier Gemini Flash model
 * - Create Bengali news with proper length
 * - Keep facts grounded in the supplied source
 * - Return predictable JSON
 *
 * No hardcoded model list. No fallback.
 * If Gemini fails, the caller (index.js) handles it.
 */

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

/*
 * Bengali summary length
 * Target ১৮০ শব্দ, minimum ১৫০ শব্দ
 */
const MIN_SUMMARY_WORDS = 150;
const TARGET_SUMMARY_WORDS = 180;

/*
 * Structured output schema.
 */
const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      headline: { type: "string" },
      summary: { type: "string" },
      main_topic: { type: "string" }
    },
    required: ["id", "headline", "summary", "main_topic"]
  }
};

/*
 * ✅ AUTO: Discover the latest free-tier Flash model from Google.
 *
 * Strategy:
 * 1. Call ListModels API
 * 2. Filter models whose name contains "flash"
 * 3. Filter models that support "generateContent"
 * 4. Sort by version number (descending)
 * 5. Return the newest one
 *
 * No fallback. If discovery fails, throws error.
 */
async function discoverLatestFlashModel(apiKey) {
  const listUrl = `${GEMINI_API_BASE}?key=${encodeURIComponent(apiKey)}`;

  console.log("[AUTO] Discovering latest Gemini Flash model...");

  const response = await fetch(listUrl, {
    method: "GET",
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    throw new Error(`ListModels API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const models = Array.isArray(data?.models) ? data.models : [];

  if (!models.length) {
    throw new Error("ListModels returned no models.");
  }

  // ✅ Filter: only "flash" models that support generateContent
  const flashModels = models
    .map(m => {
      const name = String(m?.name || "").replace(/^models\//, "");
      const methods = Array.isArray(m?.supportedGenerationMethods)
        ? m.supportedGenerationMethods
        : [];
      return { name, methods };
    })
    .filter(m => m.name.includes("flash"))
    .filter(m => m.methods.includes("generateContent"))
    .filter(m => /^gemini-\d/.test(m.name)); // must start with gemini-<number>

  if (!flashModels.length) {
    throw new Error("No free-tier Flash models found in ListModels response.");
  }

  // ✅ Sort by version number, descending
  const versionRegex = /^gemini-(\d+)\.(\d+)/;
  flashModels.sort((a, b) => {
    const ma = a.name.match(versionRegex);
    const mb = b.name.match(versionRegex);
    const aMajor = ma ? Number(ma[1]) : 0;
    const bMajor = mb ? Number(mb[1]) : 0;
    const aMinor = ma ? Number(ma[2]) : 0;
    const bMinor = mb ? Number(mb[2]) : 0;
    if (aMajor !== bMajor) return bMajor - aMajor;
    return bMinor - aMinor;
  });

  const chosen = flashModels[0].name;

  console.log(`[AUTO] Selected latest free-tier Flash model: ${chosen}`);
  console.log(`[AUTO] All eligible Flash models: ${flashModels.map(m => m.name).join(", ")}`);

  return chosen;
}

/*
 * Generate Bengali news with Gemini.
 * Auto-discovers the latest free-tier Flash model.
 */
export async function generateNewsWithGemini(articles, apiKey) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  if (!Array.isArray(articles) || articles.length === 0) {
    return [];
  }

  // ✅ Auto-discover the newest free-tier Flash model
  const model = await discoverLatestFlashModel(apiKey);

  const sourceArticles = articles.map(article => ({
    id: String(article.id),
    title: String(article.source_title || "").trim(),
    description: String(article.source_description || "").trim(),
    source: String(article.source_name || "").trim(),
    published_at: String(article.published_at || "").trim(),
    category: String(article.category || "general").trim()
  }));

  const prompt = `
You are the senior Bengali news editor for Ajker News, an Indian Bengali news website.

PRIMARY AUDIENCE: Bengali readers in India.

Your task is to rewrite the supplied source information into detailed, factual Bengali news.

COVERAGE PRIORITY:
1. West Bengal: Kolkata, West Bengal government, Mamata Banerjee, TMC, BJP Bengal, Bengal politics, Bengal crime, Bengal development, Bengal education, Bengal jobs, Bengal weather, Bengal public-interest news.
2. India: Indian government, Delhi, Parliament, Prime Minister, Supreme Court, national politics, economy, jobs, education, public-interest events.
3. Other Indian states: Important events from Maharashtra, Tamil Nadu, Karnataka, Telangana, Kerala, Gujarat, Rajasthan, Uttar Pradesh, Bihar, Assam, Odisha.
4. Major world news affecting India.
5. Business, Technology, Sports, Entertainment.

CRITICAL LENGTH REQUIREMENT:
- Each summary MUST be AT LEAST ${MIN_SUMMARY_WORDS} Bengali words.
- AIM for ${TARGET_SUMMARY_WORDS}-220 Bengali words per summary. Try hard to reach ${TARGET_SUMMARY_WORDS}.
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

  const results = await callGeminiAPI(model, prompt, apiKey);

  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("Gemini returned empty results.");
  }

  return validateAndCleanResults(results, articles);
}

/*
 * Call Gemini API with a specific model.
 */
async function callGeminiAPI(model, prompt, apiKey) {
  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: 16000
      }
    })
  });

  if (!response.ok) {
    let details = "";
    try {
      const errorData = await response.json();
      details = JSON.stringify(errorData);
    } catch {
      try {
        details = await response.text();
      } catch {
        details = "Unknown error";
      }
    }
    throw new Error(`Gemini API ${response.status}: ${details}`);
  }

  const data = await response.json();

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("Gemini returned no text output.");
  }

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

/*
 * Validate and clean all Gemini results.
 */
function validateAndCleanResults(results, originalArticles) {
  return results
    .map(result => validateGeminiResult(result, originalArticles))
    .filter(Boolean);
}

/*
 * Validate one Gemini result.
 */
function validateGeminiResult(result, originalArticles) {
  if (!result || typeof result !== "object") {
    return null;
  }

  const id = String(result.id || "").trim();
  if (!id) return null;

  const original = originalArticles.find(
    article => String(article.id) === id
  );

  if (!original) return null;

  const headline = cleanText(result.headline);
  const summary = cleanText(result.summary);
  const mainTopic = cleanText(result.main_topic);

  if (!headline || !summary || !mainTopic) {
    return null;
  }

  // ✅ Word count validation
  const wordCount = summary.split(/\s+/).filter(Boolean).length;

  if (wordCount < MIN_SUMMARY_WORDS) {
    console.warn(`[REJECT] Summary too short (${wordCount} words < ${MIN_SUMMARY_WORDS}) for ID ${id}`);
    return null;
  }

  if (wordCount < TARGET_SUMMARY_WORDS) {
    console.warn(`[BELOW TARGET] ${wordCount} words (target ${TARGET_SUMMARY_WORDS}) for ID ${id}`);
  }

  if (headline.length > 180) {
    return null;
  }

  if (summary.length > 2500) {
    return null;
  }

  return {
    id,
    headline,
    summary,
    main_topic: mainTopic
  };
}

/*
 * Basic text cleanup.
 */
function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * Process selected articles.
 */
export async function processSelectedNews(articles, apiKey) {
  if (!Array.isArray(articles) || articles.length === 0) {
    return [];
  }

  const limitedArticles = articles.slice(0, 25);

  return await generateNewsWithGemini(limitedArticles, apiKey);
}

/*
 * Small helper for logging without exposing the API key.
 */
export function geminiStatus(apiKey) {
  return {
    configured: Boolean(apiKey),
    mode: "auto-discover-latest-flash",
    minWords: MIN_SUMMARY_WORDS,
    targetWords: TARGET_SUMMARY_WORDS
  };
}
