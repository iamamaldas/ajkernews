/*
 * AJKER NEWS — FAST INDEX / DISCOVERY / GOOGLE INDEXING API
 * Multi-channel URL discovery for published news.
 */

import { submitToIndexNow } from "./indexnow.js";
import { notifyWebSub } from "./websub.js";

const SITE = "https://ajkernews.in";
const MAX_URLS_PER_BATCH = 100;
const BING_MAX_URLS = 500;

export async function fastIndexNews(env, ids) {
  const list = [...new Set((ids || []).map(id => String(id || "").trim()).filter(Boolean))];

  if (!list.length) {
    return { ok: true, submitted: 0, successfulChannels: 0, channels: [] };
  }

  // র বা প্রপার বাংলা পাথ (Double-Encoding আটকাতে encodeURIComponent বাদ দেওয়া হয়েছে)
  const urls = list.map(id => `${SITE}/news/${id}`);

  const jobs = [
    ["google_indexing_api", () => submitToGoogleIndexingAPI(env, urls)],
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

// ✅ গুগলের অফিশিয়াল ইনস্ট্যান্ট ইনডেক্সিং এপিআই মেকানিজম
async function submitToGoogleIndexingAPI(env, urls) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return { ok: false, reason: "missing_service_account_json" };
  }

  try {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const clientEmail = serviceAccount.client_email;
    const privateKey = serviceAccount.private_key;

    const now = Math.floor(Date.now() / 1000);
    const jwtHeader = { alg: "RS256", typ: "JWT" };
    const jwtPayload = {
      iss: clientEmail,
      scope: "https://googleapis.com",
      aud: "https://googleapis.com",
      iat: now,
      exp: now + 3600
    };

    const base64url = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+\$/, '');
    const encodeJWT = (obj) => base64url(JSON.stringify(obj));
    const unsignedToken = `${encodeJWT(jwtHeader)}.${encodeJWT(jwtPayload)}`;

    const pemContents = privateKey
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s/g, "");

    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryDer.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(unsignedToken)
    );

    const signedJWT = `${unsignedToken}.${base64url(String.fromCharCode(...new Uint8Array(signature)))}`;

    const tokenRes = await fetch("https://googleapis.com", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJWT}`
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return { ok: false, error: "token_exchange_failed", details: tokenData };

    const accessToken = tokenData.access_token;
    let successfulPings = 0;

    // প্রতিটি ইউআরএল গুগলে পাঠানো হচ্ছে
    for (const url of urls) {
      const res = await fetch("https://googleapis.com", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: url,
          type: "URL_UPDATED"
        })
      });
      if (res.ok) successfulPings++;
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

async function submitToBing(env, urls) {
  if (!env.BING_API_KEY) return { ok: false, reason: "no_key" };
  const siteUrl = `${SITE}/`;
  const endpoint = `https://bing.com{encodeURIComponent(env.BING_API_KEY)}`;
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

async function pingPingOMatic() {
  const title = encodeURIComponent("Ajker News");
  const url = encodeURIComponent(SITE);
  try {
    const response = await fetch(`https://pingomatic.com{title}&url=${url}`, { method: "GET" });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
