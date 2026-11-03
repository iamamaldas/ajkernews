// worker/src/fast-index.js
// ✅ FINAL v5: Google Indexing API + IndexNow + Bing + WebSub + Perfect URL Handling

import { submitToIndexNow } from "./indexnow.js";
import { notifyWebSub } from "./websub.js";
import { createSignedJWT, getGoogleAccessToken } from "./jwt.js";

const SITE = "https://ajkernews.in";
const MAX_URLS_PER_BATCH = 100;
const BING_MAX_URLS = 500;

// ⚠️ Google Indexing API সাধারণ নিউজ/কুইজের জন্য বন্ধ রাখাই নিরাপদ
const ENABLE_GOOGLE_INDEXING_API = false;

export async function fastIndexNews(env, ids) {
  const list = [...new Set((ids || []).map(id => String(id || "").trim()).filter(Boolean))];

  if (!list.length) {
    return { ok: true, submitted: 0, successfulChannels: 0, channels: [] };
  }

  // ✅ পারফেক্ট URL বিল্ডার
  const urls = list.map(id => {
    // ১. যদি আইডি 'quiz/' দিয়ে শুরু হয় (যেমন: quiz/2026-11-03)
    if (id.startsWith("quiz/")) {
      return `${SITE}/${id}`; 
    }
    // ২. যদি শুধু ডেট ফরম্যাট হয় (যেমন: 2026-11-03)
    if (/^\d{4}-\d{2}-\d{2}$/.test(id)) {
        return `${SITE}/quiz/${id}`;
    }
    // ৩. যদি আগে থেকেই news/ থাকে (ভুলবশত পাঠানো হলে সেটি বাদ যাবে)
    if (id.startsWith("news/")) {
        return `${SITE}/${id.replace(/^news\//, '')}`; 
    }
    // ৪. সাধারণ স্লাগ (নিউজ বা কুইজ)
    return `${SITE}/${id}`;
  });

  const jobs = [
    ...(ENABLE_GOOGLE_INDEXING_API 
      ? [["google_indexing_api", () => submitToGoogleIndexingAPI(env, urls)]] 
      : []),
    ["indexnow", () => submitIndexNowInChunks(env, urls)],
    ["bing", () => submitToBing(env, urls)],
    ["websub", () => notifyWebSub(env, `${SITE}/rss.xml`)],
    ["pingomatic", () => pingPingOMatic()]
  ];

  const settled = await Promise.allSettled(
    jobs.map(([, job]) => Promise.resolve().then(job))
  );

  const channels = settled.map((result, index) => {
    const channel = jobs[index][0];
    if (result.status === "fulfilled") {
      const info = result.value || {};
      return { channel, ok: info.ok !== false, info };
    }
    return {
      channel,
      ok: false,
      info: { error: result.reason?.message || String(result.reason) }
    };
  });

  const successfulChannels = channels.filter(item => item.ok).length;
  const ok = successfulChannels > 0;

  console.log("[FAST-INDEX] Summary:", JSON.stringify({
    urls: urls.length,
    successfulChannels,
    channels
  }));

  return { ok, submitted: urls.length, successfulChannels, channels };
}

async function submitToGoogleIndexingAPI(env, urls) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { ok: false, reason: "missing_google_service_account_json" };
  }
  try {
    let serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      return { ok: false, error: "missing_credentials_fields" };
    }
    const signedJWT = await createSignedJWT(
      serviceAccount.client_email, serviceAccount.private_key,
      "https://www.googleapis.com/auth/indexing", "https://oauth2.googleapis.com/token"
    );
    const tokenData = await getGoogleAccessToken(signedJWT);
    if (!tokenData.access_token) return { ok: false, error: "token_exchange_failed" };

    const accessToken = tokenData.access_token;
    let successfulPings = 0;
    for (const url of urls) {
      try {
        const res = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
            method: "POST", headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ url: url, type: "URL_UPDATED" })
        });
        if (res.ok) successfulPings++;
      } catch (e) {}
    }
    return { ok: successfulPings > 0, submitted: successfulPings, total: urls.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function submitIndexNowInChunks(env, urls) {
  const chunks = [];
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_BATCH) {
    chunks.push(urls.slice(i, i + MAX_URLS_PER_BATCH));
  }
  let submitted = 0;
  for (const chunk of chunks) {
    try {
      const result = await submitToIndexNow(env, chunk);
      if (result?.error || result?.ok === false) continue;
      submitted += chunk.length;
    } catch (error) {}
  }
  return { ok: submitted > 0, submitted };
}

async function submitToBing(env, urls) {
  if (!env.BING_API_KEY) return { ok: false, reason: "no_key" };
  const siteUrl = `${SITE}/`;
  const endpoint = `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${encodeURIComponent(env.BING_API_KEY)}`;
  const urlList = urls.slice(0, BING_MAX_URLS);
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl, urlList })
    });
    return { ok: response.ok, submitted: response.ok ? urlList.length : 0 };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function pingPingOMatic() {
  const title = encodeURIComponent("Ajker News");
  const url = encodeURIComponent(SITE);
  try {
    const response = await fetch(`https://pingomatic.com/ping/?title=${title}&url=${url}`, { method: "GET" });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
