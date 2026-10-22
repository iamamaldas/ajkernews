// worker/src/quiz-generator.js
// ✅ FINAL: Same Auto Model Discovery as gemini.js + 12-Question Validation

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = 25000;

const QUIZ_PROMPT = `You are a quiz master for a Bengali news website. Create exactly 12 multiple-choice questions for today's daily quiz.

TOPIC: Based on Google Trends and recent news from India and West Bengal (Politics, Sports, Entertainment, Business, Technology).

REQUIREMENTS:
- You MUST create exactly 12 questions.
- Each question must have 4 options.
- Only 1 option is correct.
- Provide a short explanation for the correct answer.
- Language: Bengali (বাংলা).
- Return JSON array with this exact structure:
[
  {
    "id": 1,
    "question": "প্রশ্ন...",
    "options": ["অপশন A", "অপশন B", "অপশন C", "অপশন D"],
    "correct": 0,
    "explanation": "ব্যাখ্যা..."
  }
]
- 'correct' is the index (0-3) of the correct option.
- Do NOT include any markdown or extra text. Return ONLY valid JSON.
`;

let cachedModels = null;
let cacheTime = 0;
const MODEL_CACHE_TTL = 60 * 60 * 1000;

// ✅ EXACT SAME LOGIC AS YOUR gemini.js
async function discoverModels(apiKey) {
  if (cachedModels && (Date.now() - cacheTime) < MODEL_CACHE_TTL) {
    return cachedModels;
  }

  // ✅ Using the exact fallback models that work in your gemini.js
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
      console.warn(`[QUIZ] ListModels ${response.status} — using fallback`);
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
      console.warn("[QUIZ] No Flash from ListModels — using fallback");
      cachedModels = FALLBACK_MODELS;
      cacheTime = Date.now();
      return cachedModels;
    }

    const priority = ["gemini-2.0-flash", "gemini-2.0-flash-001"];
    const priorityList = available.filter(m => priority.includes(m));
    const restList = available.filter(m => !priority.includes(m));

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

    console.log(`[QUIZ] Available models: ${merged.join(" → ")}`);
    cachedModels = merged;
    cacheTime = Date.now();
    return merged;
  } catch (error) {
    console.warn("[QUIZ] Discovery failed:", error?.message || String(error));
    cachedModels = FALLBACK_MODELS;
    cacheTime = Date.now();
    return cachedModels;
  }
}

// ✅ Main Quiz Generator
export async function generateDailyQuiz(apiKey) {
  if (!apiKey) {
    console.warn("[QUIZ] No Gemini API Key");
    return null;
  }

  // Auto-discover models (same as gemini.js)
  const models = await discoverModels(apiKey);
  
  for (const model of models) {
    try {
      console.log(`[QUIZ] Trying model: ${model}...`);
      const result = await callGemini(model, apiKey);
      
      // ✅ Accept 12 or more questions, slice to exactly 12
      if (result && Array.isArray(result) && result.length >= 12) {
        console.log(`[QUIZ] ✅ Success with model ${model} (${result.length} questions)`);
        return result.slice(0, 12); 
      } else if (result && Array.isArray(result) && result.length > 0) {
        console.warn(`[QUIZ] Model ${model} returned ${result.length} questions instead of 12.`);
      }
    } catch (error) {
      console.warn(`[QUIZ] Model ${model} failed:`, error.message);
    }
  }
  return null;
}

async function callGemini(model, apiKey) {
  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: QUIZ_PROMPT }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
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

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`API ${response.status}: ${errText.slice(0, 150)}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response from Gemini");

    let parsed;
    try { parsed = JSON.parse(text); } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error("JSON parse failed");
    }
    return parsed;
  } finally {
    clearTimeout(timeoutId);
  }
}
