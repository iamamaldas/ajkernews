// auto-deploy test - 2026-09-18
/**
 * =========================================================
 * AJKER NEWS - CLOUDFLARE WORKER
 * FINAL v25 — Firebase FCM + Gemini + Multi-Channel Indexing
 * =========================================================
 */

import webPush from "web-push";
import { FCM, FcmOptions } from "fcm-cloudflare-workers";
import ANALYTICS_CONFIG from "./config-analytics.js";
import ADS_CONFIG from "./config-ads.js";
import AFFILIATE_CONFIG from "./config-affiliate.js";
import { processSelectedNews } from "./gemini.js";
import { runGNewsBatch } from "./news-fetcher.js";
import { selectBestCandidates, publishSelectedNews } from "./news-selector.js";
import { enforceNewsLimit, cleanOldCandidates, cleanRejectedNews } from "./cleanup.js";
import { fastIndexNews } from "./fast-index.js";
import { cacheNewsApi, purgeNewsApiCache, purgeArticleCache } from "./cache.js";

const MAX_NEWS = 1000;
const API_PAGE_SIZE = 10;

let tablesReadyPromise = null;

const BN_TO_EN_MAP = {
  "অ":"o","আ":"a","ই":"i","ঈ":"i","উ":"u","ঊ":"u",
  "ঋ":"ri","এ":"e","ঐ":"oi","ও":"o","ঔ":"ou",
  "ক":"k","খ":"kh","গ":"g","ঘ":"gh","ঙ":"ng",
  "চ":"ch","ছ":"chh","জ":"j","ঝ":"jh","ঞ":"n",
  "ট":"t","ঠ":"th","ড":"d","ঢ":"dh","ণ":"n",
  "ত":"t","থ":"th","দ":"d","ধ":"dh","ন":"n",
  "প":"p","ফ":"ph","ব":"b","ভ":"bh","ম":"m",
  "য":"j","র":"r","ল":"l",
  "শ":"sh","ষ":"sh","স":"s","হ":"h",
  "ড়":"r","ঢ়":"rh","য়":"y",
  "ং":"ng","ঃ":"h","ঁ":"n",
  "া":"a","ি":"i","ী":"i","ু":"u","ূ":"u",
  "ৃ":"ri","ে":"e","ৈ":"oi","ো":"o","ৌ":"ou"
};

function toTransliterated(text) {
  if (!text) return "";
  let result = "";
  for (const char of String(text)) {
    result += BN_TO_EN_MAP[char] || char;
  }
  return result.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/* =========================================================
 * BOT DETECTION
 * ========================================================= */
const BOT_REGEX = /googlebot|google-inspectiontool|apis-google|mediapartners-google|adsbot-google|googleother|feedfetcher-google|google-read-aloud|google-site-verification|storebot-google|googlebot-news|googlebot-image|googlebot-video|bingbot|msnbot|adidxbot|bingpreview|yandex|baiduspider|baiduboxapp|sogou|exabot|duckduckbot|duckassistbot|applebot|applebot-extended|slurp|twitterbot|facebookexternalhit|facebookcatalog|facebot|whatsapp|telegrambot|linkedinbot|pinterest|slackbot|discordbot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|gptbot|chatgpt-user|perplexitybot|ccbot|anthropic-ai|claude-web|youbot|lighthouse|chrome-lighthouse/i;

/* =========================================================
 * VAPID Email — Auto-prefix mailto:
 * ========================================================= */
function getVapidEmail(env) {
  const raw = String(env.VAPID_EMAIL || "").trim();
  if (!raw) return "mailto:info@ajkernews.in";
  if (raw.toLowerCase().startsWith("mailto:")) return raw;
  return `mailto:${raw}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      await ensureTablesOnce(env);

      if (url.pathname === "/sitemap.xml") return await generateSitemap(env);
      if (url.pathname === "/news-sitemap.xml") return await generateNewsSitemap(env);
      if (url.pathname === "/rss.xml") return await generateRSS(env);
      if (url.pathname === "/robots.txt") return generateRobotsTxt();

      const userAgent = request.headers.get("User-Agent") || "";
      const isBot = BOT_REGEX.test(userAgent);

      if (url.pathname.startsWith("/news/") && request.method === "GET") {
        const articleId = decodeURIComponent(url.pathname.slice(6).split("/")[0] || "").trim();
        if (!articleId) return Response.redirect("https://ajkernews.in/", 302);
        return await serveArticlePage(articleId, env);
      }

      if (env.INDEXNOW_KEY && url.pathname === `/${env.INDEXNOW_KEY}.txt`) {
        return new Response(env.INDEXNOW_KEY, {
          status: 200,
          headers: { "content-type": "text/plain; charset=UTF-8", "Cache-Control": "public, max-age=86400" }
        });
      }

      if (url.pathname === "/" && request.method === "GET" && isBot) {
        const articleId = url.searchParams.get("id");
        if (articleId) return await serveArticlePage(articleId, env);
        const cat = url.searchParams.get("category");
        if (cat && cat !== "top" && cat !== "all") return await serveBotCategoryPage(cat, env);
        return await serveBotHomepage(env);
      }

      if (ANALYTICS_CONFIG.searchConsole && url.pathname === ANALYTICS_CONFIG.searchConsole.filePath) {
        return new Response(ANALYTICS_CONFIG.searchConsole.content, {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8" }
        });
      }

      if (url.pathname === "/ads.txt") {
        return new Response(ADS_CONFIG.adsTxtContent, {
          status: 200,
          headers: { "content-type": "text/plain; charset=UTF-8" }
        });
      }

      if (url.pathname.startsWith("/go/")) {
        const id = url.pathname.split("/")[2];
        if (!id) return new Response("Invalid link", { status: 400 });
        return await serveSharePage(id, env, userAgent, url);
      }

      if (url.pathname === "/api/affiliate" && request.method === "GET") {
        return await handleAffiliate(url, env);
      }

      if (url.pathname === "/news" && url.searchParams.has("id")) {
        const id = url.searchParams.get("id");
        return Response.redirect(`https://ajkernews.in/news/${encodeURIComponent(id)}`, 301);
      }

      if (url.pathname === "/api/news") {
        return await handleGetNews(url, env, request);
      }

      if (url.pathname === "/api/update") {
        if (request.method !== "POST") {
          return json({ success: false, error: "POST method required" }, 405, 0);
        }
        const result = await updateNews(env);
        if (result.published > 0 && Array.isArray(result.newNewsIds) && result.newNewsIds.length) {
          ctx.waitUntil(
            queueAndSendPushNotifications(env, result.newNewsIds).catch(error =>
              console.error("Push queue error:", error?.message || String(error))
            )
          );
        }
        return json(result, 200, 0);
      }

      if (url.pathname === "/api/love") {
        if (request.method !== "POST") return json({ error: "POST required" }, 405, 0);
        return await toggleLove(request, env);
      }

      if (url.pathname === "/api/comments") {
        if (request.method === "GET") return await getComments(url, env);
        if (request.method === "POST") return await addComment(request, env);
        return json({ error: "Method not allowed" }, 405, 0);
      }

      if (url.pathname === "/api/push-config" && request.method === "GET") {
        return json({ success: true, publicKey: env.VAPID_PUBLIC_KEY || "" }, 200, 0);
      }

      if (url.pathname === "/api/subscribe" && request.method === "POST") {
        return await handleSubscribe(request, env);
      }

      if (url.pathname === "/api/unsubscribe" && request.method === "POST") {
        return await handleUnsubscribe(request, env);
      }

      if (url.pathname === "/api/push-sync" && request.method === "POST") {
        return await handlePushSync(request, env);
      }

      if (url.pathname === "/api/debug" && request.method === "GET") {
        try {
          const stats = await env.DB.prepare(`SELECT status, COUNT(*) AS count FROM news GROUP BY status`).all();
          const recent = await env.DB.prepare(`SELECT id, headline, status, created_at, published_at FROM news ORDER BY created_at DESC LIMIT 10`).all();
          const pushSubs = await env.DB.prepare(`SELECT COUNT(*) AS total FROM push_subscriptions`).first();
          const fcmSubs = await env.DB.prepare(`SELECT COUNT(*) AS total FROM push_subscriptions WHERE token IS NOT NULL AND token != ''`).first();
          return json({
            success: true,
            stats: stats.results || [],
            recent: recent.results || [],
            push: {
              subscribers: Number(pushSubs?.total || 0),
              fcmTokens: Number(fcmSubs?.total || 0)
            }
          }, 200, 0);
        } catch (error) {
          return json({ success: false, error: error.message }, 500, 0);
        }
      }

      if (url.pathname === "/api/fast-index-test" && request.method === "POST") {
        try {
          const body = await request.json();
          const ids = Array.isArray(body.ids) ? body.ids : [];
          if (!ids.length) return json({ success: false, error: "ids array required" }, 400, 0);
          const result = await fastIndexNews(env, ids);
          return json({ success: true, result }, 200, 0);
        } catch (error) {
          return json({ success: false, error: error.message }, 500, 0);
        }
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Ajker News Worker is running.", {
        status: 200,
        headers: { "content-type": "text/plain; charset=UTF-8" }
      });
    } catch (error) {
      console.error("Worker error:", error?.message || error?.stack || String(error));
      return json({ success: false, error: error?.message || "Internal server error" }, 500, 0);
    }
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    const startTime = Date.now();
    console.log(`[CRON] ${cron} started at ${new Date(event.scheduledTime).toISOString()}`);

    try {
      if (cron === "0 */2 * * *") {
        let result;
        try {
          result = await updateNews(env);
          console.log("[CRON-NEWS] Result:", JSON.stringify(result));
        } catch (error) {
          console.error("[CRON-NEWS] updateNews failed:", error?.message || String(error));
          return;
        }

        const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
        const istHour = istNow.getUTCHours();
        const isNightTime = istHour >= 23 || istHour < 6;
        const isEvenHour = istHour % 2 === 0;
        const shouldSendNotification = isEvenHour && !isNightTime;

        console.log(`[NOTIF] IST Hour: ${istHour} | Send: ${shouldSendNotification}`);

        if (
          shouldSendNotification &&
          result.published > 0 &&
          Array.isArray(result.newNewsIds) &&
          result.newNewsIds.length
        ) {
          ctx.waitUntil(
            queueAndSendPushNotifications(env, result.newNewsIds).catch(error => {
              console.error("[CRON-NEWS] Push queue error:", error?.message || String(error));
            })
          );
        } else if (!shouldSendNotification) {
          console.log(`[NOTIF] Skipped. ${isNightTime ? 'Night time' : 'Odd hour'}.`);
        }

        console.log(`[CRON-NEWS] Completed in ${Date.now() - startTime}ms`);
        return;
      }

      if (cron === "15 */2 * * *") {
        try {
          const recent = await env.DB.prepare(
            `SELECT id FROM news WHERE status = 'published' AND created_at >= datetime('now', '-6 hours') ORDER BY created_at DESC LIMIT 50`
          ).all();
          const ids = (recent.results || []).map(r => r.id);
          if (ids.length) {
            const result = await fastIndexNews(env, ids);
            console.log(`[CRON-FAST-INDEX] ${ids.length} URLs:`, JSON.stringify(result));
          }
        } catch (error) {
          console.error("[CRON-FAST-INDEX] Failed:", error?.message || String(error));
        }
        return;
      }

      if (cron === "35 */2 * * *") {
        try {
          const backlog = await env.DB.prepare(
            `SELECT id FROM news WHERE status = 'published' AND created_at >= datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 50`
          ).all();
          const ids = (backlog.results || []).map(r => r.id);
          if (ids.length) {
            const result = await fastIndexNews(env, ids);
            console.log(`[CRON-RETRY] Backlog: ${ids.length}`, JSON.stringify(result));
          }
        } catch (error) {
          console.error("[CRON-RETRY] Backlog failed:", error?.message || String(error));
        }
        return;
      }

      if (cron === "50 */2 * * *") {
        try {
          await cleanOldCandidates(env.DB);
        } catch (error) {
          console.error("[CRON-CLEAN] Candidate cleanup failed:", error?.message || String(error));
        }

        try {
          await cleanRejectedNews(env.DB);
        } catch (error) {
          console.error("[CRON-CLEAN] Rejected cleanup failed:", error?.message || String(error));
        }

        const currentHour = new Date().getUTCHours();
        if ([0, 6, 12, 18].includes(currentHour)) {
          try {
            const cleanupResult = await enforceNewsLimit(env.DB);
            console.log(`[CRON-CLEAN] News: ${cleanupResult.deleted} deleted, ${cleanupResult.total} total`);
            if (cleanupResult.deleted > 0) {
              try {
                await purgeNewsApiCache("https://ajkernews.in");
                for (const id of cleanupResult.deletedIds || []) {
                  await purgeArticleCache("https://ajkernews.in", id);
                }
              } catch (e) { /* ignore */ }
            }
          } catch (error) {
            console.error("[CRON-CLEAN] News cleanup failed:", error?.message || String(error));
          }
        }

        try {
          await Promise.allSettled([
            fetch(`https://www.bing.com/ping?sitemap=${encodeURIComponent("https://ajkernews.in/sitemap.xml")}`).catch(() => {}),
            fetch(`https://www.bing.com/ping?sitemap=${encodeURIComponent("https://ajkernews.in/news-sitemap.xml")}`).catch(() => {})
          ]);
        } catch (e) { /* ignore */ }

        return;
      }

      console.warn(`[CRON] Unknown cron: ${cron}`);
    } catch (error) {
      console.error(`[CRON] Fatal error in ${cron}:`, error?.message || error?.stack || String(error));
    }
  }
};

/* =========================================================
 * NEWS UPDATE PIPELINE
 * ========================================================= */
async function updateNews(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  if (!env.GNEWS_API_KEY) throw new Error("GNEWS_API_KEY secret is missing");

  let batchResult = { batches: [], totalReceived: 0, totalInserted: 0 };
  try {
    batchResult = await runGNewsBatch(env.DB, env.GNEWS_API_KEY);
    console.log(`[NEWS] GNews batches:`, JSON.stringify(batchResult));
  } catch (error) {
    console.error("[NEWS] GNews batch failed:", error?.message || String(error));
    return {
      success: false, fetched: 0, inserted: 0, candidates: 0, selected: 0,
      published: 0, deleted: 0, gemini: false, newNewsIds: [],
      batches: [], message: "GNews fetch failed"
    };
  }

  try {
    const candidateCleanup = await cleanOldCandidates(env.DB);
    if (candidateCleanup.deleted > 0) {
      console.log(`[NEWS] Cleaned ${candidateCleanup.deleted} old candidates`);
    }
  } catch (error) {
    console.warn("[NEWS] Candidate cleanup failed:", error?.message || String(error));
  }

  let candidates = [];
  try {
    const candidatesResult = await env.DB.prepare(
      `SELECT * FROM news WHERE status = 'candidate' ORDER BY published_at DESC LIMIT 200`
    ).all();
    candidates = candidatesResult.results || [];
  } catch (error) {
    return {
      success: false, fetched: batchResult.totalReceived, inserted: batchResult.totalInserted,
      candidates: 0, selected: 0, published: 0, deleted: 0, gemini: false,
      newNewsIds: [], batches: batchResult.batches, message: "Candidate fetch failed"
    };
  }

  if (candidates.length === 0) {
    return {
      success: true, fetched: batchResult.totalReceived, inserted: batchResult.totalInserted,
      candidates: 0, selected: 0, published: 0, deleted: 0, gemini: false,
      newNewsIds: [], batches: batchResult.batches, message: "No candidates available"
    };
  }

  let existingPublished = [];
  try {
    const publishedResult = await env.DB.prepare(
      `SELECT source_title, headline FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT 80`
    ).all();
    existingPublished = publishedResult.results || [];
    console.log(`[NEWS] Dedup pool: ${existingPublished.length} recent published news`);
  } catch (error) {
    console.warn("[NEWS] Existing published fetch failed:", error?.message || String(error));
  }

  let selected = [];
  try {
    selected = selectBestCandidates(candidates, existingPublished);
  } catch (error) {
    return {
      success: false, fetched: batchResult.totalReceived, inserted: batchResult.totalInserted,
      candidates: candidates.length, selected: 0, published: 0, deleted: 0, gemini: false,
      newNewsIds: [], batches: batchResult.batches, message: "Selection failed"
    };
  }

  try {
    const selectedIds = new Set(selected.map(a => String(a.id)));
    const rejectedCandidates = candidates.filter(c => !selectedIds.has(String(c.id)));
    if (rejectedCandidates.length > 0) {
      const rejectedIds = rejectedCandidates.map(c => String(c.id));
      const placeholders = rejectedIds.map(() => "?").join(",");
      await env.DB.prepare(`UPDATE news SET status = 'rejected' WHERE id IN (${placeholders})`).bind(...rejectedIds).run();
      console.log(`[NEWS] Marked ${rejectedIds.length} candidates as rejected`);
    }
  } catch (error) {
    console.warn("[NEWS] Reject marking failed:", error?.message || String(error));
  }

  if (selected.length === 0) {
    return {
      success: true, fetched: batchResult.totalReceived, inserted: batchResult.totalInserted,
      candidates: candidates.length, selected: 0, published: 0, deleted: 0, gemini: false,
      newNewsIds: [], batches: batchResult.batches, message: "No selectable news"
    };
  }

  let geminiResults = [];
  let usedGemini = false;
  if (env.GEMINI_API_KEY) {
    try {
      const geminiInput = selected.map(c => ({
        id: String(c.id),
        source_title: c.source_title,
        source_description: c.source_description,
        source_name: c.source_name,
        published_at: c.published_at,
        category: c.category || "general",
        language: c.language || "en",
        additional_sources: c.additional_sources || []
      }));

      geminiResults = await Promise.race([
        processSelectedNews(geminiInput, env.GEMINI_API_KEY),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini total timeout')), 50000))
      ]).catch(err => {
        console.warn('[NEWS] Gemini timeout:', err.message);
        return [];
      });

      usedGemini = Array.isArray(geminiResults) && geminiResults.length > 0;
      console.log(`[NEWS] Gemini returned ${geminiResults.length}/${selected.length} results`);
    } catch (error) {
      console.error("[NEWS] Gemini failed:", error?.message || String(error));
    }
  }

  let publishResult = { published: 0, skipped: 0 };
  try {
    publishResult = await publishSelectedNews(env.DB, selected, geminiResults);
    console.log(`[NEWS] Published ${publishResult.published} (skipped ${publishResult.skipped || 0})`);
  } catch (error) {
    console.error("[NEWS] Publish failed:", error?.message || String(error));
  }

  const publishedIds = [];
  for (const article of selected) {
    try {
      const row = await env.DB.prepare(`SELECT id FROM news WHERE id = ? AND status = 'published'`).bind(article.id).first();
      if (row?.id) publishedIds.push(row.id);
    } catch (e) { /* ignore */ }
  }

  const searchUpdates = [];
  for (const id of publishedIds) {
    try {
      const row = await env.DB.prepare(`SELECT headline, summary, main_topic, category, source_name FROM news WHERE id = ? AND status = 'published'`).bind(id).first();
      if (!row) continue;
      const searchText = toTransliterated([row.headline, row.summary, row.main_topic, row.category, row.source_name].filter(Boolean).join(" "));
      searchUpdates.push(env.DB.prepare(`UPDATE news SET search_text = ? WHERE id = ?`).bind(searchText, id));
    } catch (e) { /* ignore */ }
  }

  if (searchUpdates.length) {
    try {
      await env.DB.batch(searchUpdates);
    } catch (error) {
      console.error("[SEARCH_TEXT] Batch update failed:", error?.message || String(error));
    }
  }

  let cleanupResult = { deleted: 0, total: 0, deletedIds: [] };
  try {
    cleanupResult = await enforceNewsLimit(env.DB);
  } catch (error) {
    console.error("[NEWS] Cleanup failed:", error?.message || String(error));
  }

  for (const id of cleanupResult.deletedIds || []) {
    try {
      await env.DB.prepare(`DELETE FROM news_loves WHERE news_id = ?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM news_comments WHERE news_id = ?`).bind(id).run();
    } catch (e) { /* ignore */ }
  }

  if (publishResult.published > 0 || cleanupResult.deleted > 0) {
    try {
      await purgeNewsApiCache("https://ajkernews.in");
      for (const id of publishedIds) await purgeArticleCache("https://ajkernews.in", id);
      for (const id of cleanupResult.deletedIds || []) await purgeArticleCache("https://ajkernews.in", id);
    } catch (error) {
      console.warn("[CACHE] Purge failed:", error?.message || String(error));
    }
  }

  if (publishedIds.length) {
    try {
      await fastIndexNews(env, publishedIds);
      console.log(`[FAST-INDEX] Published ${publishedIds.length} URLs to all channels`);
    } catch (error) {
      console.warn("[FAST-INDEX] Instant failed:", error?.message || String(error));
    }
  }

  return {
    success: true,
    fetched: batchResult.totalReceived,
    inserted: batchResult.totalInserted,
    batches: batchResult.batches,
    candidates: candidates.length,
    selected: selected.length,
    published: publishResult.published,
    skipped: publishResult.skipped || 0,
    deleted: cleanupResult.deleted,
    gemini: usedGemini,
    newNewsIds: publishedIds,
    message: `Update completed. ${publishResult.published} published, ${cleanupResult.deleted} cleaned.`
  };
}

/* =========================================================
 * BOT HOMEPAGE
 * ========================================================= */
async function serveBotHomepage(env) {
  return await serveListingPage(env, "top", null);
}

async function serveBotCategoryPage(category, env) {
  return await serveListingPage(env, category, null);
}

async function serveListingPage(env, category, searchQuery) {
  try {
    const catLabel = {
      top:'সেরা খবর', trending:'ট্রেন্ডিং', west_bengal:'পশ্চিমবঙ্গ',
      kolkata:'কলকাতা', india:'ভারত', world:'বিশ্ব', business:'ব্যবসা',
      sports:'খেলা', politics:'রাজনীতি', technology:'প্রযুক্তি',
      entertainment:'বিনোদন', crime:'অপরাধ', district:'জেলা', general:'সাধারণ'
    };

    let sql, binds;
    if (searchQuery) {
      sql = `SELECT id, headline, summary, published_at, created_at, category, image_url, source_name, main_topic FROM news WHERE status = 'published' AND (headline LIKE ? OR summary LIKE ? OR main_topic LIKE ?) ORDER BY created_at DESC LIMIT 100`;
      const q = `%${searchQuery}%`;
      binds = [q, q, q];
    } else if (category && category !== "top" && category !== "all") {
      sql = `SELECT id, headline, summary, published_at, created_at, category, image_url, source_name, main_topic FROM news WHERE status = 'published' AND category = ? ORDER BY created_at DESC LIMIT 100`;
      binds = [category];
    } else {
      sql = `SELECT id, headline, summary, published_at, created_at, category, image_url, source_name, main_topic FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT 100`;
      binds = [];
    }

    const newsResult = await env.DB.prepare(sql).bind(...binds).all();
    const news = newsResult.results || [];

    const catResult = await env.DB.prepare(`SELECT category, COUNT(*) AS cnt FROM news WHERE status = 'published' AND category IS NOT NULL GROUP BY category ORDER BY cnt DESC LIMIT 20`).all();
    const categories = catResult.results || [];

    const pageTitle = searchQuery ? `সার্চ: ${searchQuery}` : (catLabel[category] || "সেরা খবর");

    let newsHtml = "";
    for (const item of news) {
      const link = `https://ajkernews.in/news/${encodeURIComponent(item.id)}`;
      const image = item.image_url || "https://ajkernews.in/logo.png";
      const displayDate = item.created_at || item.published_at;
      const publishedDate = displayDate ? new Date(displayDate).toISOString() : new Date().toISOString();
      const cat = catLabel[item.category] || item.category || 'সংবাদ';

      newsHtml += `
        <article itemscope itemtype="https://schema.org/NewsArticle" style="margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #eee;">
          <meta itemprop="datePublished" content="${escapeHtml(publishedDate)}">
          <meta itemprop="dateModified" content="${escapeHtml(publishedDate)}">
          <meta itemprop="mainEntityOfPage" content="${escapeHtml(link)}">
          <p style="font-size:12px;color:#f44336;font-weight:700;margin:0 0 6px;">
            <a href="https://ajkernews.in/?category=${encodeURIComponent(item.category || 'top')}" style="color:#f44336;text-decoration:none;">${escapeHtml(cat)}</a>
          </p>
          <h2 itemprop="headline" style="font-size:20px;margin:0 0 8px;line-height:1.4;">
            <a href="${escapeHtml(link)}" style="color:#111;text-decoration:none;">${escapeHtml(item.headline)}</a>
          </h2>
          <p itemprop="description" style="font-size:15px;color:#444;line-height:1.6;margin:0 0 8px;">
            ${escapeHtml((item.summary || "").substring(0, 300))}...
          </p>
          <div style="font-size:12px;color:#888;">
            <span itemprop="author" itemscope itemtype="https://schema.org/Organization">
              <span itemprop="name">${escapeHtml(item.source_name || "Ajker News")}</span>
            </span>
            • <time datetime="${escapeHtml(publishedDate)}">${escapeHtml(displayDate || "")}</time>
          </div>
          <a itemprop="url" href="${escapeHtml(link)}" style="display:inline-block;margin-top:8px;color:#007bff;font-size:14px;text-decoration:none;">পূর্ণ খবর পড়ুন →</a>
        </article>`;
    }

    const catNavHtml = categories.map(c => {
      const label = catLabel[c.category] || c.category;
      return `<a href="https://ajkernews.in/?category=${encodeURIComponent(c.category)}" style="display:inline-block;margin:0 6px 6px 0;padding:6px 12px;background:#f5f5f5;border-radius:16px;color:#111;text-decoration:none;font-size:13px;">${escapeHtml(label)} (${c.cnt})</a>`;
    }).join("");

    const itemListLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      "itemListElement": news.slice(0, 10).map((item, index) => ({
        "@type": "ListItem",
        "position": index + 1,
        "url": `https://ajkernews.in/news/${encodeURIComponent(item.id)}`,
        "name": item.headline || "News"
      }))
    });

    const canonical = searchQuery ? `https://ajkernews.in/?q=${encodeURIComponent(searchQuery)}` : (category && category !== "top" ? `https://ajkernews.in/?category=${encodeURIComponent(category)}` : "https://ajkernews.in/");

    const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(pageTitle)} | আজকের নিউজ</title>
<meta name="description" content="কলকাতা, পশ্চিমবঙ্গ, ভারত ও বিশ্বের সর্বশেষ বাংলা খবর।">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(pageTitle)} | আজকের নিউজ">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="https://ajkernews.in/logo.png">
<script type="application/ld+json">${itemListLd}</script>
</head>
<body style="max-width:820px;margin:0 auto;padding:20px;font-family:Inter,-apple-system,sans-serif;color:#111;">
<header>
  <h1 style="font-size:28px;margin:0 0 6px;"><a href="/" style="color:#111;text-decoration:none;">আজকের নিউজ</a></h1>
  <p style="color:#666;font-size:15px;margin:0 0 16px;">${escapeHtml(pageTitle)}</p>
  <nav style="margin-bottom:24px;">${catNavHtml}</nav>
</header>
<main>${newsHtml}</main>
<footer style="margin-top:40px;padding-top:20px;border-top:1px solid #eee;text-align:center;color:#888;font-size:13px;">
  <p>&copy; ${new Date().getFullYear()} Ajker News</p>
  <p>
    <a href="https://ajkernews.in/sitemap.xml" style="color:#007bff;">Sitemap</a> ·
    <a href="https://ajkernews.in/news-sitemap.xml" style="color:#007bff;">News Sitemap</a> ·
    <a href="https://ajkernews.in/rss.xml" style="color:#007bff;">RSS</a>
  </p>
</footer>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        "Cache-Control": "public, max-age=300, s-maxage=600",
        "X-Robots-Tag": "index, follow, max-image-preview:large"
      }
    });
  } catch (error) {
    console.error("Listing page error:", error?.message || String(error));
    return new Response("Error loading content", { status: 500 });
  }
}

/* =========================================================
 * ARTICLE PAGE
 * ========================================================= */
async function serveArticlePage(id, env) {
  const safeId = String(id || "").trim();
  if (!safeId) return Response.redirect("https://ajkernews.in/", 302);

  const result = await env.DB.prepare(
    `SELECT headline, summary, main_topic, image_url, published_at, created_at, source_name, source_url, category FROM news WHERE id = ? AND status = 'published' LIMIT 1`
  ).bind(safeId).first();

  if (!result) return Response.redirect("https://ajkernews.in/", 302);

  const title = cleanText(result.headline) || "Ajker News";
  const description = cleanText(result.summary || "").slice(0, 160);
  const fullSummary = cleanText(result.summary || result.main_topic || "");
  const image = result.image_url || "https://ajkernews.in/logo.png";
  const displayDate = result.created_at || result.published_at || new Date().toISOString();
  const publishedAt = displayDate;
  const canonical = `https://ajkernews.in/news/${encodeURIComponent(safeId)}`;
  const category = result.category || "general";

  let relatedNews = [];
  try {
    const related = await env.DB.prepare(
      `SELECT id, headline FROM news WHERE status = 'published' AND id != ? AND category = ? ORDER BY created_at DESC LIMIT 4`
    ).bind(safeId, category).all();
    relatedNews = related.results || [];
  } catch (e) { /* ignore */ }

  const catLabel = {
    top:'সেরা খবর', trending:'ট্রেন্ডিং', west_bengal:'পশ্চিমবঙ্গ',
    kolkata:'কলকাতা', india:'ভারত', world:'বিশ্ব', business:'ব্যবসা',
    sports:'খেলা', politics:'রাজনীতি', technology:'প্রযুক্তি',
    entertainment:'বিনোদন', crime:'অপরাধ', district:'জেলা', general:'সাধারণ'
  };

  const newsArticleLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "mainEntityOfPage": { "@type": "WebPage", "@id": canonical },
    "headline": title.slice(0, 110),
    "description": description,
    "image": [image, "https://ajkernews.in/logo.png"],
    "datePublished": publishedAt,
    "dateModified": publishedAt,
    "author": { "@type": "Organization", "name": result.source_name || "Ajker News", "url": "https://ajkernews.in/" },
    "publisher": {
      "@type": "NewsMediaOrganization",
      "name": "Ajker News",
      "url": "https://ajkernews.in/",
      "logo": { "@type": "ImageObject", "url": "https://ajkernews.in/logo.png", "width": 512, "height": 512 }
    },
    "articleSection": category,
    "inLanguage": "bn-IN",
    "isAccessibleForFree": true,
    "url": canonical
  });

  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "হোম", "item": "https://ajkernews.in/" },
      { "@type": "ListItem", "position": 2, "name": catLabel[category] || category, "item": `https://ajkernews.in/?category=${category}` },
      { "@type": "ListItem", "position": 3, "name": title, "item": canonical }
    ]
  });

  const relatedHtml = relatedNews.length ? `
  <aside style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;">
    <h3 style="font-size:18px;margin:0 0 14px;color:#111;">সম্পর্কিত খবর</h3>
    <ul style="list-style:none;padding:0;margin:0;">
      ${relatedNews.map(n => `<li style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #f0f0f0;"><a href="https://ajkernews.in/news/${encodeURIComponent(n.id)}" style="color:#111;text-decoration:none;font-size:15px;line-height:1.5;">${escapeHtml(n.headline || "")}</a></li>`).join("")}
    </ul>
  </aside>` : "";

  const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Ajker News</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:site_name" content="Ajker News">
<meta property="article:published_time" content="${escapeHtml(publishedAt)}">
<meta property="article:modified_time" content="${escapeHtml(publishedAt)}">
<meta property="article:section" content="${escapeHtml(category)}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${newsArticleLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
</head>
<body style="max-width:780px;margin:0 auto;padding:20px;font-family:Inter,-apple-system,sans-serif;color:#111;line-height:1.7;">
<header style="margin-bottom:20px;">
  <p style="margin:0 0 12px;"><a href="https://ajkernews.in/" style="color:#007bff;text-decoration:none;font-size:14px;">← আজকের নিউজ হোম</a></p>
</header>
<article itemscope itemtype="https://schema.org/NewsArticle">
  <meta itemprop="datePublished" content="${escapeHtml(publishedAt)}">
  <meta itemprop="dateModified" content="${escapeHtml(publishedAt)}">
  <meta itemprop="mainEntityOfPage" content="${escapeHtml(canonical)}">
  <p style="font-size:12px;color:#f44336;font-weight:700;margin:0 0 8px;">
    <a href="https://ajkernews.in/?category=${encodeURIComponent(category)}" style="color:#f44336;text-decoration:none;">${escapeHtml(catLabel[category] || category)}</a>
  </p>
  <h1 itemprop="headline" style="font-size:28px;line-height:1.35;margin:0 0 12px;color:#111;">${escapeHtml(title)}</h1>
  <div style="font-size:13px;color:#888;margin-bottom:16px;">
    <span itemprop="author" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">${escapeHtml(result.source_name || "Ajker News")}</span></span>
    • <time datetime="${escapeHtml(publishedAt)}">${escapeHtml(publishedAt)}</time>
  </div>
  <div itemprop="image" itemscope itemtype="https://schema.org/ImageObject" style="margin-bottom:18px;">
    <img itemprop="url" src="${escapeHtml(image)}" alt="${escapeHtml(title)}" style="width:100%;height:auto;border-radius:8px;display:block;" width="1200" height="675" loading="eager" decoding="async">
  </div>
  <div itemprop="articleBody" style="font-size:17px;color:#222;line-height:1.85;">
    <p>${escapeHtml(fullSummary)}</p>
  </div>
  ${result.source_url ? `<p style="margin-top:20px;font-size:14px;color:#666;">সূত্র: <a href="${escapeHtml(result.source_url)}" rel="noopener noreferrer nofollow" style="color:#007bff;text-decoration:none;">${escapeHtml(result.source_name || "মূল উৎস")}</a></p>` : ""}
</article>
${relatedHtml}
<footer style="margin-top:40px;padding-top:20px;border-top:1px solid #eee;text-align:center;color:#888;font-size:13px;">
  <p>&copy; ${new Date().getFullYear()} Ajker News</p>
  <p><a href="https://ajkernews.in/sitemap.xml" style="color:#007bff;">Sitemap</a> · <a href="https://ajkernews.in/news-sitemap.xml" style="color:#007bff;">News Sitemap</a></p>
</footer>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=300, s-maxage=600",
      "X-Robots-Tag": "index, follow, max-image-preview:large"
    }
  });
}

/* =========================================================
 * TABLES SETUP — includes token column for FCM
 * ========================================================= */
async function ensureTables(env) {
  const queries = [
    `CREATE TABLE IF NOT EXISTS news (id TEXT PRIMARY KEY, source_url TEXT UNIQUE, source_name TEXT, source_title TEXT, source_description TEXT, headline TEXT, summary TEXT, main_topic TEXT, category TEXT, language TEXT DEFAULT 'bn', image_url TEXT, published_at TEXT, created_at TEXT, day_key TEXT, status TEXT DEFAULT 'published', score INTEGER DEFAULT 0, search_text TEXT, indexed_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS news_loves (id INTEGER PRIMARY KEY AUTOINCREMENT, news_id TEXT, device_id TEXT, UNIQUE(news_id, device_id))`,
    `CREATE TABLE IF NOT EXISTS news_comments (id TEXT PRIMARY KEY, news_id TEXT, author_name TEXT, comment_text TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, endpoint TEXT UNIQUE, keys_json TEXT, token TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS affiliate_clicks (id TEXT PRIMARY KEY, affiliate_name TEXT, click_url TEXT, device_id TEXT, created_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_news_status_published ON news(status, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_status_created ON news(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_category_published ON news(category, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_score_published ON news(score DESC, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_loves_news_id ON news_loves(news_id)`,
    `CREATE INDEX IF NOT EXISTS idx_news_comments_news_created ON news_comments(news_id, created_at ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_token ON push_subscriptions(token)`
  ];

  for (const sql of queries) {
    try {
      await env.DB.prepare(sql).run();
    } catch (error) {
      console.error("Table setup error:", error?.message || String(error));
    }
  }

  try {
    const columns = await env.DB.prepare(`PRAGMA table_info(news)`).all();
    const colNames = (columns.results || []).map(c => c.name);
    if (!colNames.includes("language")) {
      console.log("[MIGRATION] Adding language column");
      await env.DB.prepare(`ALTER TABLE news ADD COLUMN language TEXT DEFAULT 'bn'`).run();
    }
  } catch (error) {
    console.error("Column migration failed:", error?.message || String(error));
  }

  // ✅ Add token column to push_subscriptions (for FCM)
  try {
    const pushColumns = await env.DB.prepare(`PRAGMA table_info(push_subscriptions)`).all();
    const pushColNames = (pushColumns.results || []).map(c => c.name);
    if (!pushColNames.includes("token")) {
      console.log("[MIGRATION] Adding token column to push_subscriptions");
      await env.DB.prepare(`ALTER TABLE push_subscriptions ADD COLUMN token TEXT`).run();
    }
  } catch (error) {
    console.error("Push subscriptions migration failed:", error?.message || String(error));
  }
}

async function ensureTablesOnce(env) {
  if (!tablesReadyPromise) {
    tablesReadyPromise = ensureTables(env);
  }
  try {
    await tablesReadyPromise;
  } catch (error) {
    tablesReadyPromise = null;
    throw error;
  }
}

/* =========================================================
 * SHARE PAGE
 * ========================================================= */
async function serveSharePage(id, env, requestUserAgentFromContext = "", requestUrl = null) {
  const safeId = String(id || "").trim();
  if (!safeId) return Response.redirect("https://ajkernews.in/", 302);

  const userAgent = (requestUserAgentFromContext || "").toLowerCase();
  const socialCrawlerPatterns = ["facebookexternalhit","facebot","twitterbot","linkedinbot","whatsapp","telegrambot","discordbot","slackbot","pinterest","skypeuripreview"];

  if (socialCrawlerPatterns.some(pattern => userAgent.includes(pattern))) {
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive"
      }
    });
  }

  const result = await env.DB.prepare(`SELECT id FROM news WHERE id = ? AND status = 'published' LIMIT 1`).bind(safeId).first();
  if (!result) return Response.redirect("https://ajkernews.in/", 302);

  const homeUrl = `https://ajkernews.in/news/${encodeURIComponent(safeId)}`;
  const html = `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta http-equiv="refresh" content="0;url=${escapeHtml(homeUrl)}"><script>window.location.replace(${JSON.stringify(homeUrl)});</script></head><body><noscript><a href="${escapeHtml(homeUrl)}">পূর্ণ খবর দেখতে এই লিঙ্কে ক্লিক করুন</a></noscript></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive"
    }
  });
}

async function handleAffiliate(url, env) {
  const ref = url.searchParams.get("ref") || "direct";
  let targetUrl = url.searchParams.get("url");

  if (!targetUrl && AFFILIATE_CONFIG.redirectMap && AFFILIATE_CONFIG.redirectMap[ref]) {
    targetUrl = AFFILIATE_CONFIG.redirectMap[ref];
  }
  if (!targetUrl) targetUrl = AFFILIATE_CONFIG.defaultRedirect;

  if (AFFILIATE_CONFIG.trackClicks) {
    try {
      await env.DB.prepare(`INSERT INTO affiliate_clicks (id, affiliate_name, click_url, device_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), ref, targetUrl, "unknown", new Date().toISOString()).run();
    } catch (error) {
      console.error("Affiliate log error:", error?.message || String(error));
    }
  }
  return Response.redirect(targetUrl, 302);
}

/* =========================================================
 * API: GET NEWS
 * ========================================================= */
async function handleGetNews(url, env, request) {
  return cacheNewsApi(request, async () => {
    return await handleGetNewsInternal(url, env);
  });
}

async function handleGetNewsInternal(url, env) {
  const category = url.searchParams.get("category") || "top";
  const query = (url.searchParams.get("q") || "").trim();
  const specificId = url.searchParams.get("id");
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));

  const requestedLimit = parseInt(url.searchParams.get("limit") || "10", 10);
  const limit = Math.min(Math.max(requestedLimit, 1), 20);
  const queryLimit = limit + 1;

  const selectFields = `news.id, news.headline, news.summary, news.main_topic, news.category, news.image_url, news.published_at, news.source_name, news.source_url, news.created_at, news.score, COUNT(nl.id) AS love_count`;

  if (specificId) {
    const result = await env.DB.prepare(`SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id WHERE news.id = ? AND news.status = 'published' GROUP BY news.id LIMIT 1`).bind(specificId).all();
    const news = result.results || [];
    return json({ success: true, count: news.length, news }, 200, 0);
  }

  let result;
  if (query) {
    const transliterated = toTransliterated(query);
    result = await env.DB.prepare(`SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id WHERE news.status = 'published' AND (news.search_text LIKE ? OR news.headline LIKE ? OR news.summary LIKE ? OR news.main_topic LIKE ?) GROUP BY news.id ORDER BY news.created_at DESC, news.published_at DESC LIMIT ? OFFSET ?`).bind(`%${transliterated}%`, `%${query}%`, `%${query}%`, `%${query}%`, queryLimit, offset).all();
  } else if (category === "trending") {
    result = await env.DB.prepare(`SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id WHERE news.status = 'published' GROUP BY news.id ORDER BY news.score DESC, news.created_at DESC LIMIT ? OFFSET ?`).bind(queryLimit, offset).all();
  } else if (category !== "top" && category !== "all") {
    result = await env.DB.prepare(`SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id WHERE news.status = 'published' AND news.category = ? GROUP BY news.id ORDER BY news.created_at DESC, news.published_at DESC LIMIT ? OFFSET ?`).bind(category, queryLimit, offset).all();
  } else {
    result = await env.DB.prepare(`SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id WHERE news.status = 'published' GROUP BY news.id ORDER BY news.created_at DESC, news.published_at DESC LIMIT ? OFFSET ?`).bind(queryLimit, offset).all();
  }

  const rawNews = result?.results || [];
  const hasMore = rawNews.length > limit;
  const news = rawNews.slice(0, limit);

  return json({ success: true, count: news.length, offset, limit, has_more: hasMore, news }, 200, 0);
}

/* =========================================================
 * PUSH NOTIFICATIONS — FIREBASE FCM
 * ========================================================= */
async function handleSubscribe(request, env) {
  try {
    const body = await request.json();
    const token = body?.token || body?.endpoint;
    if (!token) {
      return json({ success: false, error: "Token required" }, 400, 0);
    }

    const endpoint = body?.endpoint || `fcm:${token.slice(0, 32)}`;
    const keys = JSON.stringify(body?.keys || {});
    const now = new Date().toISOString();

    const existing = await env.DB.prepare(
      `SELECT id FROM push_subscriptions WHERE token = ? OR endpoint = ? LIMIT 1`
    ).bind(token, endpoint).first();

    if (existing) {
      await env.DB.prepare(`UPDATE push_subscriptions SET token = ?, keys_json = ? WHERE id = ?`).bind(token, keys, existing.id).run();
      console.log(`[SUBSCRIBE] Updated: ${token.slice(0, 20)}...`);
      return json({ success: true, message: "Updated" }, 200, 0);
    }

    await env.DB.prepare(`INSERT INTO push_subscriptions (id, endpoint, keys_json, token, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), endpoint, keys, token, now).run();

    console.log(`[SUBSCRIBE] New FCM token: ${token.slice(0, 20)}...`);
    return json({ success: true }, 200, 0);
  } catch (error) {
    console.error("Subscribe error:", error?.message || String(error));
    return json({ success: false, error: "Subscribe error" }, 500, 0);
  }
}

async function handleUnsubscribe(request, env) {
  try {
    const { endpoint, token } = await request.json();
    const id = token || endpoint;
    if (!id) return json({ error: "Missing token/endpoint" }, 400, 0);

    const result = await env.DB.prepare(`DELETE FROM push_subscriptions WHERE token = ? OR endpoint = ?`).bind(id, id).run();
    if (result.meta?.changes > 0) {
      return json({ success: true, message: "Unsubscribed" }, 200, 0);
    } else {
      return json({ success: false, message: "Not found" }, 404, 0);
    }
  } catch (error) {
    console.error("Unsubscribe error:", error?.message || String(error));
    return json({ success: false, error: "Unsubscribe error" }, 500, 0);
  }
}

/* =========================================================
 * Send Push via FCM
 * ========================================================= */
async function queueAndSendPushNotifications(env, newsIds) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.warn("[PUSH] FIREBASE_SERVICE_ACCOUNT_JSON secret missing");
    return;
  }

  const ids = [...new Set((newsIds || []).filter(Boolean))];
  if (!ids.length) return;

  // Get latest news
  const placeholders = ids.map(() => "?").join(",");
  const latestNews = await env.DB.prepare(`
    SELECT id, headline, summary, image_url
    FROM news
    WHERE id IN (${placeholders}) AND status = 'published'
    ORDER BY created_at DESC, score DESC
    LIMIT 1
  `).bind(...ids).first();

  if (!latestNews) {
    console.log("[PUSH] No latest news found");
    return;
  }

  // Get FCM tokens
  const subs = await env.DB.prepare(
    `SELECT token FROM push_subscriptions WHERE token IS NOT NULL AND token != '' ORDER BY created_at DESC LIMIT 500`
  ).all();

  if (!subs.results?.length) {
    console.log("[PUSH] No FCM subscribers");
    return;
  }

  const tokens = subs.results.map(s => s.token).filter(Boolean);
  console.log(`[PUSH-FCM] Sending to ${tokens.length} subscribers`);

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.error("[PUSH-FCM] Invalid service account JSON:", e.message);
    return;
  }

  const fcm = new FCM(new FcmOptions({ serviceAccount }));

  const targetUrl = `https://ajkernews.in/news/${latestNews.id}`;
  const title = String(latestNews.headline || "নতুন খবর").slice(0, 180);
  const body = String(latestNews.summary || "বিস্তারিত জানতে ক্লিক করুন").slice(0, 180);

  try {
    const unregisteredTokens = await fcm.sendToTokens({
      notification: { title, body },
      data: {
        url: targetUrl,
        image: latestNews.image_url || "",
        notificationId: `news:${latestNews.id}`
      },
      webpush: {
        notification: {
          icon: "https://ajkernews.in/logo.png",
          badge: "https://ajkernews.in/logo.png",
          image: latestNews.image_url || undefined
        },
        fcmOptions: { link: targetUrl }
      }
    }, tokens);

    const sent = tokens.length - (unregisteredTokens?.length || 0);
    console.log(`[PUSH-FCM] Sent: ${sent}, Invalid: ${unregisteredTokens?.length || 0}`);

    // Cleanup invalid tokens
    if (unregisteredTokens && unregisteredTokens.length > 0) {
      const cleanPlaceholders = unregisteredTokens.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM push_subscriptions WHERE token IN (${cleanPlaceholders})`).bind(...unregisteredTokens).run();
      console.log(`[PUSH-FCM] Removed ${unregisteredTokens.length} invalid tokens`);
    }
  } catch (error) {
    console.error("[PUSH-FCM] Send failed:", error?.message || String(error));
  }
}

async function handlePushSync(request, env) {
  // With FCM, pending sync is not needed
  return json({ success: true, synced: true }, 200, 0);
}

/* =========================================================
 * LOVE + COMMENTS
 * ========================================================= */
async function toggleLove(request, env) {
  try {
    const { id, deviceId } = await request.json();
    if (!id || !deviceId) return json({ error: "Missing id or deviceId" }, 400, 0);

    const existing = await env.DB.prepare(`SELECT id FROM news_loves WHERE news_id = ? AND device_id = ?`).bind(id, deviceId).first();

    if (existing) {
      await env.DB.prepare(`DELETE FROM news_loves WHERE news_id = ? AND device_id = ?`).bind(id, deviceId).run();
    } else {
      await env.DB.prepare(`INSERT INTO news_loves (news_id, device_id) VALUES (?, ?)`).bind(id, deviceId).run();
    }

    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM news_loves WHERE news_id = ?`).bind(id).first();
    return json({ success: true, love_count: Number(count?.count || 0) }, 200, 0);
  } catch (error) {
    return json({ success: false, error: error?.message || "Love error" }, 500, 0);
  }
}

async function getComments(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400, 0);
  const result = await env.DB.prepare(`SELECT id, author_name, comment_text, created_at FROM news_comments WHERE news_id = ? ORDER BY created_at ASC`).bind(id).all();
  return json({ comments: result.results || [] }, 200, 0);
}

async function addComment(request, env) {
  try {
    const { newsId, author, text } = await request.json();
    if (!newsId || !text) return json({ error: "Missing fields" }, 400, 0);
    const id = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO news_comments (id, news_id, author_name, comment_text, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, newsId, cleanText(author || "Guest"), cleanText(text), new Date().toISOString()).run();
    return json({ success: true, comment_id: id }, 200, 0);
  } catch (error) {
    return json({ success: false, error: error?.message || "Comment error" }, 500, 0);
  }
}

/* =========================================================
 * SITEMAP
 * ========================================================= */
async function generateSitemap(env) {
  try {
    const result = await env.DB.prepare(`SELECT id, published_at, created_at FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT 1000`).all();
    const news = result.results || [];
    const baseUrl = "https://ajkernews.in";

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`;

    for (const item of news) {
      const displayDate = item.created_at || item.published_at;
      const lastmod = displayDate ? new Date(displayDate).toISOString() : new Date().toISOString();
      xml += `\n  <url><loc>${baseUrl}/news/${encodeURIComponent(item.id)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`;
    }
    xml += `\n</urlset>`;

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=UTF-8",
        "Cache-Control": "public, max-age=300, s-maxage=600",
        ...corsHeaders()
      }
    });
  } catch (error) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://ajkernews.in/</loc></url></urlset>`, {
      status: 200,
      headers: { "Content-Type": "application/xml; charset=UTF-8" }
    });
  }
}

async function generateNewsSitemap(env) {
  try {
    const result = await env.DB.prepare(`SELECT id, headline, summary, main_topic, category, published_at, created_at FROM news WHERE status = 'published' AND created_at >= datetime('now', '-2 days') ORDER BY created_at DESC LIMIT 1000`).all();
    const news = result.results || [];
    const base = "https://ajkernews.in";

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">`;

    for (const n of news) {
      const displayDate = n.created_at || n.published_at;
      const publishedAt = displayDate ? new Date(displayDate).toISOString() : new Date().toISOString();
      const safeTitle = String(n.headline || "News").slice(0, 110);
      const keywords = [n.category || "general", n.main_topic || ""].filter(Boolean).join(", ").slice(0, 200);

      xml += `\n  <url><loc>${base}/news/${encodeURIComponent(n.id)}</loc><lastmod>${publishedAt}</lastmod><news:news><news:publication><news:name>Ajker News</news:name><news:language>bn</news:language></news:publication><news:publication_date>${publishedAt}</news:publication_date><news:title>${escapeHtml(safeTitle)}</news:title>${keywords ? `<news:keywords>${escapeHtml(keywords)}</news:keywords>` : ""}<news:genres>Blog</news:genres></news:news></url>`;
    }
    xml += `\n</urlset>`;

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=UTF-8",
        "Cache-Control": "public, max-age=300, s-maxage=600",
        ...corsHeaders()
      }
    });
  } catch (error) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"></urlset>`, {
      status: 200,
      headers: { "Content-Type": "application/xml; charset=UTF-8" }
    });
  }
}

function generateRobotsTxt() {
  const text = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /go/

User-agent: Googlebot-News
Allow: /

User-agent: Googlebot
Allow: /
Crawl-delay: 1

User-agent: Bingbot
Allow: /
Crawl-delay: 1

User-agent: Bingbot-News
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

Sitemap: https://ajkernews.in/sitemap.xml
Sitemap: https://ajkernews.in/news-sitemap.xml
`;

  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600"
    }
  });
}

async function generateRSS(env) {
  const result = await env.DB.prepare(`SELECT id, headline, summary, published_at, created_at, image_url, source_name FROM news WHERE status='published' ORDER BY created_at DESC LIMIT 50`).all();
  const news = result.results || [];
  const base = "https://ajkernews.in";

  const items = news.map(n => {
    const link = `${base}/news/${encodeURIComponent(n.id)}`;
    const displayDate = n.created_at || n.published_at;
    const pubDate = displayDate ? new Date(displayDate).toUTCString() : new Date().toUTCString();
    const safeDesc = String(n.summary || "").replace(/]]>/g, "]]]]><![CDATA[>");
    return `<item><title>${escapeHtml(n.headline)}</title><link>${link}</link><guid isPermaLink="true">${link}</guid><pubDate>${pubDate}</pubDate><description><![CDATA[${safeDesc}]]></description>${n.image_url ? `<enclosure url="${escapeHtml(n.image_url)}" type="image/jpeg"/>` : ""}</item>`;
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>আজকের নিউজ</title>
  <link>${base}/</link>
  <description>কলকাতা, পশ্চিমবঙ্গ, ভারত ও বিশ্বের সর্বশেষ বাংলা খবর</description>
  <language>bn-IN</language>
  <atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml"/>
  <atom:link rel="hub" href="https://pubsubhubbub.appspot.com/"/>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=UTF-8",
      "Cache-Control": "public, max-age=300, s-maxage=600"
    }
  });
}

/* =========================================================
 * HELPERS
 * ========================================================= */
function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400"
  };
}

function json(data, status = 200, cacheSeconds = 60) {
  const seconds = Math.max(0, Number(cacheSeconds) || 0);
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=UTF-8",
      "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}`
    }
  });
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
