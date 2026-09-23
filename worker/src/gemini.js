// worker/src/gemini.js
// ✅ FIXED: cleanText utils থেকে import
// ✅ Unchanged logic

import { cleanText } from "./utils.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MIN_SUMMARY_WORDS = 80;
const TARGET_SUMMARY_WORDS = 150;
const RETRY_MIN_WORDS = 60;

const GEMINI_TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 8192;
const MAX_PARALLEL = 3;
const MAX_RETRIES_PER_ARTICLE = 2;
const RETRY_DELAY_MS = 2000;
const BATCH_DELAY_MS = 2500;

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

export async function processSelectedNews(articles, apiKey) {
  if (!apiKey) {
    console.warn("[GEMINI] No API key");
    return [];
  }
  if (!Array.isArray(articles) || articles.length === 0) return [];

  const models = await discoverModels(apiKey);
  const allResults = [];
  const totalBatches = Math.ceil(articles.length / MAX_PARALLEL);

  console.log(`[GEMINI] Processing ${articles.length} articles in ${totalBatches} batches`);

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

    if (i + MAX_PARALLEL < articles.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`[GEMINI] Success: ${allResults.length}/${articles.length}`);
  return allResults;
}

async function processOneArticle(article, models, apiKey) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES_PER_ARTICLE; attempt++) {
    const isRetry = attempt > 1;
    const prompt = buildPrompt(article, isRetry);
    const maxTokens = isRetry ? MAX_OUTPUT_TOKENS : 5000;

    for (const model of models) {
      try {
        const result = await callGeminiAPI(model, prompt, apiKey, maxTokens);
        const
