// worker/src/quiz-generator.js
// ✅ FINAL: Auto Model Discovery + Real-Time Google Trends + Govt Exam Current Affairs

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = 25000;

// ✅ ১. Google Trends RSS ফিড থেকে আজকের ট্রেন্ডিং কীওয়ার্ড আনার ফাংশন
async function fetchTrendingKeywords() {
  try {
    const res = await fetch("https://trends.google.com/trending/rss?geo=IN", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) return [];
    const xml = await res.text();
    
    // XML থেকে <title> ট্যাগের ভেতরের লেখা বের করা
    const titles = [...xml.matchAll(/<title>(.*?)<\/title>/g)].map(m => m[1]);
    
    // প্রথম title সাধারণত "Daily Search Trends" থাকে, সেটি বাদ দিয়ে টপ ৫টি নেওয়া
    const cleanTitles = titles.slice(1).filter(t => t && !t.includes("Daily Search Trends"));
    return cleanTitles.slice(0, 5);
  } catch (e) {
    console.warn("[QUIZ] Google Trends fetch failed:", e.message);
    return [];
  }
}

// ✅ ২. মূল প্রম্পট (এখানে ট্রেন্ডিং কীওয়ার্ড ডাইনামিকভাবে বসবে)
function buildPrompt(trendingKeywords) {
  const trendsText = trendingKeywords.length > 0 
    ? `Here are the ACTUAL trending search keywords in India RIGHT NOW: ${trendingKeywords.join(", ")}. You MUST base the quiz on one of these real-time topics.`
    : `Use your knowledge of today's top news in India and West Bengal.`;

  return `You are an expert exam setter for Indian Government Competitive Exams (like WBCS, SSC, Railway, Bank, Police) and an SEO Quiz Master for a Bengali news website. 

TASK:
${trendsText}
1. From the trending topics provided, select the single most important topic that is highly relevant for Government Exam aspirants.
2. Create exactly 12 multiple-choice questions (MCQs) based on this selected topic, strictly following the standard of Indian Government Exams.

CRITICAL INSTRUCTIONS:
- The questions MUST be factual, educational, and based on current events (যেমন: নতুন সরকারি যোজনা, রাষ্ট্রপতির সফর, সাম্প্রতিক পুরস্কার, বা বাজেট).
- Do NOT use vague options. Use strong distractors (confusing wrong options) just like real WBCS/SSC exams.
- IMPORTANT: Rotate the topics on a daily basis. Do not pick Cricket or Sports every day, but if a major national sports event (like World Cup, Olympics) is trending, you MUST include it. Other days, focus on Politics, West Bengal Local News, Economy, Science, and Government Schemes.
- Language: Bengali (বাংলা) with English terms in brackets where necessary (e.g., "ভারতের রাষ্ট্রপতি (President)").

REQUIREMENTS:
- You MUST create exactly 12 questions.
- Each question must have 4 options.
- Only 1 option is correct.
- Provide a short and precise explanation for the correct answer.
- Return JSON array with this exact structure:
[
  {
    "id": 1,
    "mainTopic": "দিনের সেরা কারেন্ট অ্যাফেয়ার্স (যেমন: G20 Summit 2026)",
    "question": "প্রশ্ন...",
    "options": ["অপশন A", "অপশন B", "অপশন C", "অপশন D"],
    "correct": 0,
    "explanation": "ব্যাখ্যা..."
  }
]
- 'correct' is the index (0-3) of the correct option.
- Do NOT include any markdown or extra text. Return ONLY valid JSON.
`;
}

let cachedModels = null;
let cacheTime = 0;
const MODEL_CACHE_TTL = 60 * 60 * 1000;

async function discoverModels(apiKey) {
  if (cachedModels && (Date.now() - cacheTime) < MODEL_CACHE_TTL) {
    return cachedModels;
  }

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
    cachedModels = merged;
    cacheTime = Date.now();
    return merged;
  } catch (error) {
    cachedModels = FALLBACK_MODELS;
    cacheTime = Date.now();
    return cachedModels;
  }
}

export async function generateDailyQuiz(apiKey) {
  if (!apiKey) return null;

  // ✅ ৩. প্রথমে গুগল ট্রেন্ডিং কীওয়ার্ড আনা হচ্ছে
  const trendingKeywords = await fetchTrendingKeywords();
  console.log("[QUIZ] Live Trending Topics:", trendingKeywords);

  // ✅ ৪. ট্রেন্ডিং কীওয়ার্ড দিয়ে প্রম্পট তৈরি করা হচ্ছে
  const dynamicPrompt = buildPrompt(trendingKeywords);

  const models = await discoverModels(apiKey);
  
  for (const model of models) {
    try {
      const result = await callGemini(model, apiKey, dynamicPrompt);
      if (result && Array.isArray(result) && result.length >= 12) {
        return result.slice(0, 12); 
      }
    } catch (error) {
      console.warn(`[QUIZ] Model ${model} failed:`, error.message);
    }
  }
  return null;
}

async function callGemini(model, apiKey, promptText) {
  const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
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

    if (!response.ok) throw new Error(`API ${response.status}`);
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response");

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
