/*
 * AJKER NEWS — FAST INDEX / DISCOVERY
 *
 * Multi-channel URL discovery for published news.
 *
 * Active channels:
 *   1. IndexNow
 *   2. Bing Webmaster URL submission (when BING_API_KEY exists)
 *   3. WebSub notification for RSS subscribers/consumers
 *   4. Ping-O-Matic (best-effort legacy discovery channel)
 *
 * Google sitemap ping is intentionally NOT used. Google retired the
 * unauthenticated sitemap-ping endpoint; Google discovery should come from
 * robots.txt + Search Console sitemap submission + normal crawling.
 *
 * Google Indexing API is also intentionally NOT used for ordinary news
 * articles. Google documents that API for JobPosting and BroadcastEvent in a
 * VideoObject. Ordinary news URLs use sitemap/news-sitemap/RSS/internal links.
 */

import { submitToIndexNow } from "./indexnow.js";
import { notifyWebSub } from "./websub.js";

const SITE = "https://ajkernews.in";
const MAX_URLS_PER_BATCH = 100;
const BING_MAX_URLS = 500;

export async function fastIndexNews(env, ids) {
  const list = [...new Set((ids || []).map(id => String(id || "").trim()).filter(Boolean))];

  if (!list.length) {
    return {
      ok: true,
      submitted: 0,
      successfulChannels: 0,
      channels: []
    };
  }

  const urls = list.map(id => `${SITE}/news/${encodeURIComponent(id)}`);

  // Keep channel work isolated. One provider failing must never block the
  // other discovery channels.
  const jobs = [
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
      return {
        channel,
        ok: info.ok !== false,
        info
      };
    }
    return {
      channel,
      ok: false,
      info: { error: result.reason?.message || String(result.reason) }
    };
  });

  const successfulChannels = channels.filter(item => item.ok).length;
  const ok = successfulChannels > 0;

  console.log(
    "[FAST-INDEX] Summary:",
    JSON.stringify({
      urls: urls.length,
      successfulChannels,
      channels
    })
  );

  return {
    ok,
    submitted: urls.length,
    successfulChannels,
    channels
  };
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
        errors.push(result?.error || "IndexNow submission returned ok=false");
        continue;
      }
      submitted += chunk.length;
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  if (errors.length && submitted === 0) {
    return { ok: false, submitted: 0, errors };
  }

  return {
    ok: submitted > 0,
    submitted,
    errors: errors.length ? errors : undefined
  };
}

async function submitToBing(env, urls) {
  if (!env.BING_API_KEY) {
    return { ok: false, reason: "no_key" };
  }

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

    return {
      ok: response.ok,
      status: response.status,
      submitted: response.ok ? urlList.length : 0,
      response: text.slice(0, 500)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

async function pingPingOMatic() {
  const title = encodeURIComponent("Ajker News");
  const url = encodeURIComponent(SITE);

  try {
    const response = await fetch(
      `https://rpc.pingomatic.com/?title=${title}&url=${url}`,
      { method: "GET" }
    );

    return {
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}
