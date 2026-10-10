// worker/src/fast-index.js
// ✅ FIXED v2: Google Indexing API — Disabled but Ready for Future
// ✅ Toggle Variable: ENABLE_GOOGLE_INDEXING_API
// ✅ IndexNow, Bing, WebSub, PingOMatic সব Active
// ✅ ভবিষ্যতে Google Permission পেলে শুধু true করলেই Automatic চালু

import { submitToIndexNow } from "./indexnow.js";
import { notifyWebSub } from "./websub.js";
import { createSignedJWT, getGoogleAccessToken } from "./jwt.js";

const SITE = "https://ajkernews.in";
const MAX_URLS_PER_BATCH = 100;
const BING_MAX_URLS = 500;

// ═══════════════════════════════════════════════════════════
// ✅ GOOGLE INDEXING API TOGGLE — Master Switch
// ═══════════════════════════════════════════════════════════
// Google Indexing API শুধু JobPosting ও BroadcastEvent এর জন্য।
// NewsArticle-এর জন্য Google অফিসিয়ালি সাপোর্ট করে না।
//
// 📌 যখন Google Permission দেবে (বা আপনি নিজে চেষ্টা করতে চান):
//    শুধু নিচের লাইনটি false → true করে দিন
//    এবং wrangler.toml-এ GOOGLE_SERVICE_ACCOUNT_JSON সেট করুন
//
// 👇 এই লাইনটি পরিবর্তন করুন:
const ENABLE_GOOGLE_INDEXING_API = false;  // ← true করলেই Automatic চালু
// ═══════════════════════════════════════════════════════════

export async function fastIndexNews(env, ids) {
  const list = [...new Set((ids || []).map(id => String(id || "").trim()).filter(Boolean))];

  if (!list.length) {
    return { ok: true, submitted: 0, successfulChannels: 0, channels: [] };
  }

  const urls = list.map(id => `${SITE}/news/${id}`);

  // ✅ Google Indexing API — Toggle চেক
  const jobs = [
    // ✅ Google Indexing API (শুধু ENABLE_GOOGLE_INDEXING_API = true হলে চলবে)
    ...(ENABLE_GOOGLE_INDEXING_API 
      ? [["google_indexing_api", () => submitToGoogleIndexingAPI(env, urls)]] 
      : []),
    
    // ✅ Automatic Channels (সবসময় চালু — আপনার Automation)
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
    googleIndexingEnabled: ENABLE_GOOGLE_INDEXING_API,
    successfulChannels,
    channels
  }));

  return { ok, submitted: urls.length, successfulChannels, channels };
}

// ═══════════════════════════════════════════════════════════
// ✅ Google Indexing API — Complete Function (Disabled by Default)
// ═══════════════════════════════════════════════════════════
// ENABLE_GOOGLE_INDEXING_API = false হলে এই function কখনো কল হবে না।
// true করলে Automatic কাজ করবে (Permission পেলে)।
// ═══════════════════════════════════════════════════════════
async function submitToGoogleIndexingAPI(env, urls) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log('[GOOGLE-INDEXING] SKIPPED — GOOGLE_SERVICE_ACCOUNT_JSON missing');
    return { ok: false, reason: "missing_google_service_account_json" };
  }

  try {
    const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const signedJWT = await createSignedJWT(
      serviceAccount.client_email,
      serviceAccount.private_key,
      "https://www.googleapis.com/auth/indexing",
      "https://oauth2.googleapis.com/token"
    );

    const tokenData = await getGoogleAccessToken(signedJWT);
    if (!tokenData.access_token) {
      console.log('[GOOGLE-INDEXING] Token exchange failed');
      return { ok: false, error: "token_exchange_failed", details: tokenData };
    }

    const accessToken = tokenData.access_token;
    let successfulPings = 0;

    for (const url of urls) {
      try {
        const res = await fetch(
          "https://indexing.googleapis.com/v3/urlNotifications:publish",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              url: url,
              type: "URL_UPDATED"
            })
          }
        );
        if (res.ok) successfulPings++;
      } catch (e) {
        // Individual URL failure — continue
      }
    }

    console.log(`[GOOGLE-INDEXING] ${successfulPings}/${urls.length} submitted`);
    return { ok: successfulPings > 0, submitted: successfulPings, total: urls.length };
  } catch (error) {
    console.log('[GOOGLE-INDEXING] Error:', error.message);
    return { ok: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════
// ✅ IndexNow (Bing, Yandex, Naver, Seznam) — Always Active
// ═══════════════════════════════════════════════════════════
async function submitIndexNowInChunks(env, urls) {
  const chunks = [];
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_BATCH) {
    chunks.push(urls.slice(i, i + MAX_URLS_PER_BATCH));
  }
  let submitted = 0;
  const errors = [];
  for (const chunk of chunks) {
    try {
      const result = await submitToIndexNow(env, chunk);
      if (result?.error || result?.ok === false) {
        errors.push(result?.error || "IndexNow ok=false");
        continue;
      }
      submitted += chunk.length;
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  if (errors.length && submitted === 0) return { ok: false, submitted: 0, errors };
  return { ok: submitted > 0, submitted, errors: errors.length ? errors : undefined };
}

// ═══════════════════════════════════════════════════════════
// ✅ Bing Webmaster API — Always Active
// ═══════════════════════════════════════════════════════════
async function submitToBing(env, urls) {
  if (!env.BING_API_KEY) return { ok: false, reason: "no_key" };
  const siteUrl = `${SITE}/`;
  const endpoint = `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${encodeURIComponent(env.BING_API_KEY)}`;
  const urlList = urls.slice(0, BING_MAX_URLS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl, urlList })
    });
    const text = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, submitted: response.ok ? urlList.length : 0, response: text.slice(0, 500) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// ═══════════════════════════════════════════════════════════
// ✅ Ping-O-Matic — Always Active
// ═══════════════════════════════════════════════════════════
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
