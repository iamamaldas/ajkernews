/*
 * Gemini news writer
 *
 * Purpose:
 * - Take selected source articles
 * - Create concise Bengali news
 * - Keep the facts grounded in the supplied source
 * - Return predictable JSON
 *
 * One Gemini request can process multiple selected articles.
 */

const GEMINI_MODEL = "gemini-3.7-flash";

const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;


/*
 * Structured output schema.
 *
 * Every generated item must contain:
 * - original article ID
 * - Bengali headline
 * - Bengali short summary
 * - main topic
 */
const RESPONSE_SCHEMA = {
  type: "array",

  items: {
    type: "object",

    properties: {

      id: {
        type: "string"
      },

      headline: {
        type: "string"
      },

      summary: {
        type: "string"
      },

      main_topic: {
        type: "string"
      }

    },

    required: [
      "id",
      "headline",
      "summary",
      "main_topic"
    ]
  }
};


/*
 * Generate Bengali short news.
 */
export async function generateNewsWithGemini(
  articles,
  apiKey
) {

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured."
    );
  }

  if (
    !Array.isArray(articles) ||
    articles.length === 0
  ) {
    return [];
  }


  /*
   * Send only the information needed by Gemini.
   *
   * The original source URL is retained by our
   * database but is not treated as factual content.
   */
  const sourceArticles =
    articles.map(article => ({

      id:
        String(article.id),

      title:
        String(
          article.source_title || ""
        ).trim(),

      description:
        String(
          article.source_description || ""
        ).trim(),

      source:
        String(
          article.source_name || ""
        ).trim(),

      published_at:
        String(
          article.published_at || ""
        ).trim(),

      category:
        String(
          article.category || "general"
        ).trim()

    }));


  const prompt = `
You are the Bengali short-news editor for Ajker News.

Your task is to rewrite the supplied source information
into concise, factual Bengali news.

IMPORTANT RULES:

1. Use ONLY facts contained in the supplied source data.
2. Do NOT invent names, numbers, quotes, locations, dates,
   causes, reactions or other details.
3. Do NOT add opinions or speculation.
4. Do NOT copy the source headline word-for-word.
5. Write natural, clear Bengali suitable for a mobile
   short-news website.
6. Each summary should normally be approximately 50–60
   Bengali words.
7. If the source information is insufficient, write a
   shorter factual summary rather than inventing details.
8. Preserve important names, organisations, places,
   numbers and dates exactly when supported by the source.
9. Do not mention that AI was used.
10. Do not use promotional or clickbait language.
11. Do not create facts merely to reach a word count.
12. Return one result for every supplied article.
13. Keep the original article ID unchanged.
14. The main_topic should be a short Bengali topic label.

SOURCE ARTICLES:

${JSON.stringify(
  sourceArticles,
  null,
  2
)}
`;


  const response =
    await fetch(
      `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({

          contents: [
            {
              role: "user",

              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],

          generationConfig: {

            temperature: 0.2,

            responseMimeType:
              "application/json",

            responseSchema:
              RESPONSE_SCHEMA
          }

        })
      }
    );


  /*
   * Handle API errors.
   */
  if (!response.ok) {

    let details = "";

    try {

      const errorData =
        await response.json();

      details =
        JSON.stringify(
          errorData
        );

    } catch {
      details =
        await response.text();
    }

    throw new Error(
      `Gemini API failed: HTTP ${response.status} ${details}`
    );
  }


  const data =
    await response.json();


  /*
   * Extract Gemini's text output.
   */
  const text =
    data?.candidates?.[0]
      ?.content?.parts?.[0]
      ?.text;


  if (!text) {

    throw new Error(
      "Gemini returned no text output."
    );
  }


  /*
   * Structured output should already be JSON,
   * but we still validate it before using it.
   */
  let results;

  try {

    results =
      JSON.parse(text);

  } catch {

    throw new Error(
      "Gemini returned invalid JSON."
    );
  }


  if (!Array.isArray(results)) {

    throw new Error(
      "Gemini response is not an array."
    );
  }


  /*
   * Validate and clean every generated result.
   */
  const validResults =
    results
      .map(result =>
        validateGeminiResult(
          result,
          articles
        )
      )
      .filter(Boolean);


  return validResults;
}


/*
 * Validate one Gemini result.
 */
function validateGeminiResult(
  result,
  originalArticles
) {

  if (
    !result ||
    typeof result !== "object"
  ) {
    return null;
  }


  const id =
    String(
      result.id || ""
    ).trim();


  if (!id) {
    return null;
  }


  /*
   * Make sure the returned ID actually belongs
   * to one of the supplied articles.
   */
  const original =
    originalArticles.find(
      article =>
        String(article.id) === id
    );


  if (!original) {
    return null;
  }


  const headline =
    cleanText(
      result.headline
    );


  const summary =
    cleanText(
      result.summary
    );


  const mainTopic =
    cleanText(
      result.main_topic
    );


  /*
   * Do not publish incomplete results.
   */
  if (
    !headline ||
    !summary ||
    !mainTopic
  ) {
    return null;
  }


  /*
   * Prevent extremely long generated text.
   *
   * This is a safety limit, not a forced word count.
   */
  if (
    headline.length > 180
  ) {
    return null;
  }


  if (
    summary.length > 600
  ) {
    return null;
  }


  return {

    id,

    headline,

    summary,

    main_topic:
      mainTopic
  };
}


/*
 * Basic text cleanup.
 */
function cleanText(
  value
) {

  return String(
    value ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
}


/*
 * Process selected articles.
 *
 * news-selector.js can directly use this function.
 */
export async function processSelectedNews(
  articles,
  apiKey
) {

  if (
    !Array.isArray(articles) ||
    articles.length === 0
  ) {
    return [];
  }


  /*
   * Maximum 25 articles per daily publishing batch.
   */
  const limitedArticles =
    articles.slice(0, 25);


  return await generateNewsWithGemini(
    limitedArticles,
    apiKey
  );
}


/*
 * Small helper for logging without exposing
 * the Gemini API key.
 */
export function geminiStatus(
  apiKey
) {

  return {
    configured:
      Boolean(apiKey),

    model:
      GEMINI_MODEL
  };
}