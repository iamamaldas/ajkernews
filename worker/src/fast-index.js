/*
 * FAST INDEX — Multi-channel URL submission
 * Runs after publish + on cron
 */

import { submitToIndexNow } from "./indexnow.js";
import { notifyWebSub } from "./websub.js";

const SITE = "https://ajkernews.in";

export async function fastIndexNews(env, ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return { ok: true, submitted: 0 };

  const urls = list.map(id => `${SITE}/news/${encodeURIComponent(id)}`);

  const results = await Promise.allSettled([
    submitToIndexNow(env, urls).catch(e => ({ error: e.message })),
    submitToBing(env, urls).catch(e => ({ error: e.message })),
    notifyWebSub(env, `${SITE}/rss.xml`).catch(e => ({ error: e.message })),
    pingGoogleSitemap(env).catch(e => ({ error: e.message })),
    pingPingOMatic().catch(e => ({ error: e.message }))
  ]);

  const channels = ["indexnow", "bing", "websub", "google-ping", "pingomatic"];
  const summary = results.map((r, i) => ({
    channel: channels[i],
    ok: r.status === "fulfilled" && !r.value?.error,
    info: r.status === "fulfilled" ? r.value : { error: r.reason?.message }
  }));

  console.log("[FAST-INDEX] Summary:", JSON.stringify(summary));
  return { ok: true, submitted: urls.length, channels: summary };
}

async function submitToBing(env, urls) {
  if (!env.BING_API_KEY) return { ok: false, reason: "no_key" };
  const siteUrl = "https://ajkernews.in/";
  const endpoint = `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${env.BING_API_KEY}`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl, urlList: urls.slice(0, 500) })
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pingGoogleSitemap(env) {
  const sitemapUrl = `${SITE}/sitemap.xml`;
  const newsSitemapUrl = `${SITE}/news-sitemap.xml`;
  await Promise.allSettled([
    fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`).catch(() => null),
    fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent(newsSitemapUrl)}`).catch(() => null)
  ]);
  return { ok: true };
}

async function pingPingOMatic() {
  const title = encodeURIComponent("Ajker News");
  const url = encodeURIComponent(SITE);
  try {
    await fetch(`https://rpc.pingomatic.com/?title=${title}&url=${url}`, { method: "GET" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
