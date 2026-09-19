// auto-deploy test - 2026-09-19
/**
 * =========================================================
 * AJKER NEWS - CLOUDFLARE WORKER
 * FINAL v30 — FCM + Gemini + Article Page (Exact Image Match Icons)
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

const BOT_REGEX = /googlebot|google-inspectiontool|apis-google|mediapartners-google|adsbot-google|googleother|feedfetcher-google|google-read-aloud|google-site-verification|storebot-google|googlebot-news|googlebot-image|googlebot-video|bingbot|msnbot|adidxbot|bingpreview|yandex|baiduspider|baiduboxapp|sogou|exabot|duckduckbot|duckassistbot|applebot|applebot-extended|slurp|twitterbot|facebookexternalhit|facebookcatalog|facebot|whatsapp|telegrambot|linkedinbot|pinterest|slackbot|discordbot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|gptbot|chatgpt-user|perplexitybot|ccbot|anthropic-ai|claude-web|youbot|lighthouse|chrome-lighthouse/i;

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

      if (url.pathname === "/api/love-counts") {
        const idsParam = url.searchParams.get("ids") || "";
        const ids = idsParam.split(",").map(s => s.trim()).filter(Boolean);
        if (!ids.length) return json({ success: true, counts: {} }, 200, 30);

        try {
          const placeholders = ids.map(() => "?").join(",");
          const rows = await env.DB.prepare(
            `SELECT news_id, COUNT(*) AS cnt FROM news_loves WHERE news_id IN (${placeholders}) GROUP BY news_id`
          ).bind(...ids).all();

          const counts = {};
          for (const id of ids) counts[id] = 0;
          for (const row of (rows.results || [])) {
            counts[row.news_id] = Number(row.cnt || 0);
          }

          return json({ success: true, counts }, 200, 30);
        } catch (error) {
          return json({ success: false, error: error.message }, 500, 0);
        }
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
 * ARTICLE PAGE — EXACT IMAGE MATCH (Icons)
 * ========================================================= */
async function serveArticlePage(id, env) {
  const safeId = String(id || "").trim();
  if (!safeId) return Response.redirect("https://ajkernews.in/", 302);

  const result = await env.DB.prepare(
    `SELECT headline, summary, main_topic, image_url, published_at, created_at, source_name, source_url, category FROM news WHERE id = ? AND status = 'published' LIMIT 1`
  ).bind(safeId).first();

  if (!result) return Response.redirect("https://ajkernews.in/", 302);

  let loveCount = 0;
  try {
    const loveRow = await env.DB.prepare(`SELECT COUNT(*) AS count FROM news_loves WHERE news_id = ?`).bind(safeId).first();
    loveCount = Number(loveRow?.count || 0);
  } catch (e) { /* ignore */ }

  const title = cleanText(result.headline) || "Ajker News";
  const description = cleanText(result.summary || "").slice(0, 160);
  const fullSummary = cleanText(result.summary || result.main_topic || "");
  const image = result.image_url || "https://ajkernews.in/logo.png";
  const displayDate = result.created_at || result.published_at || new Date().toISOString();
  const publishedAt = displayDate;
  const canonical = `https://ajkernews.in/news/${encodeURIComponent(safeId)}`;
  const category = result.category || "general";

  let formattedDate = "";
  try {
    const d = new Date(displayDate);
    formattedDate = d.toLocaleDateString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + d.toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { formattedDate = displayDate; }

  let sourceDomain = "";
  try {
    if (result.source_url) {
      const u = new URL(result.source_url);
      sourceDomain = u.hostname.replace(/^www\./, '');
    } else {
      sourceDomain = result.source_name || "Ajker News";
    }
  } catch (e) { sourceDomain = result.source_name || "Ajker News"; }

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
      { "@type": "ListItem", "position": 1, "name": "HOME", "item": "https://ajkernews.in/" },
      { "@type": "ListItem", "position": 2, "name": catLabel[category] || category, "item": `https://ajkernews.in/?category=${category}` },
      { "@type": "ListItem", "position": 3, "name": title, "item": canonical }
    ]
  });

  const relatedHtml = relatedNews.length ? `
  <aside class="related-box">
    <h3>সম্পর্কিত খবর</h3>
    <ul>
      ${relatedNews.map(n => `<li><a href="https://ajkernews.in/news/${encodeURIComponent(n.id)}">${escapeHtml(n.headline || "")}</a></li>`).join("")}
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
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  html { scroll-behavior: smooth; }
  body { background:#ffffff; color:#111111; -webkit-font-smoothing:antialiased; padding-bottom:20px; }

  .header { position:sticky; top:0; z-index:1000; display:flex; align-items:center; justify-content:space-between; padding:12px 16px; min-height:60px; background:#ffffff; border-bottom:1px solid #e0e0e0; }
  .header-left { display:flex; align-items:center; gap:10px; min-width:0; flex-shrink:1; }
  .back-btn { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; background:transparent; border:none; cursor:pointer; -webkit-tap-highlight-color:transparent; padding:4px; border-radius:50%; transition:background 0.15s; text-decoration:none; flex-shrink:0; }
  .back-btn:hover { background:#f0f0f0; }
  .back-btn:active { background:#e5e5e5; }
  .back-btn svg { width:22px; height:22px; stroke:#111; stroke-width:2.2; fill:none; stroke-linecap:round; stroke-linejoin:round; }
  .header-logo { height:28px; width:auto; object-fit:contain; flex-shrink:0; }
  .header-title { font-size:24px; line-height:1; font-weight:700; color:#111111; white-space:nowrap; letter-spacing:-0.3px; overflow:hidden; text-overflow:ellipsis; }

  .header-right { display:flex; align-items:center; gap:8px; flex-shrink:0; }
  .font-controls { display:flex; align-items:center; gap:6px; }
  .font-btn { width:36px; height:36px; border:1px solid #ddd; background:#fff; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; color:#333; display:inline-flex; align-items:center; justify-content:center; user-select:none; -webkit-tap-highlight-color:transparent; transition:background 0.15s, transform 0.1s; padding:0; line-height:1; font-family:inherit; }
  .font-btn:hover { background:#f5f5f5; }
  .font-btn:active { background:#eaeaea; transform:scale(0.94); }

  .article-main { padding:16px; max-width:820px; margin:0 auto; }
  .article-cat { display:inline-block; font-size:12px; color:#f44336; font-weight:700; margin-bottom:8px; text-decoration:none; }
  .article-h1 { font-size:24px; line-height:1.35; margin:0 0 14px; color:#111; font-weight:700; }
  .article-img { width:100%; height:auto; border-radius:8px; display:block; margin:0 0 18px; background:#f3f3f3; }
  .article-body { font-size:17px; color:#222; line-height:1.85; transition:font-size 0.15s ease; }
  .article-body p { margin-bottom:14px; }

  .article-source-row {
    display:flex;
    align-items:center;
    justify-content:space-between;
    flex-wrap:wrap;
    gap:8px;
    margin-top:22px;
    padding-top:16px;
    padding-bottom:16px;
    border-top:1px solid #e8e8e8;
    border-bottom:1px solid #e8e8e8;
  }
  .article-source-link {
    color:#007bff;
    text-decoration:none;
    font-weight:600;
    font-size:16px;
  }
  .article-source-link:hover { text-decoration:underline; }
  .article-date {
    color:#999999;
    font-size:14px;
    font-weight:500;
  }

  /* ===== Actions Row — Exact Image Match ===== */
  .article-actions-row {
    display:flex;
    align-items:center;
    gap:40px;
    padding:18px 0 14px;
  }
  .action-btn-art {
    display:inline-flex;
    align-items:center;
    gap:10px;
    background:none;
    border:none;
    cursor:pointer;
    padding:0;
    color:#4a4a4a;
    font-size:17px;
    font-weight:500;
    -webkit-tap-highlight-color:transparent;
    transition:transform 0.1s ease;
    line-height:1;
    font-family:inherit;
  }
  .action-btn-art:active { transform:scale(0.92); }
  .action-btn-art svg {
    width:32px;
    height:32px;
    fill:none;
    stroke:#4a4a4a;
    stroke-width:1.8;
    stroke-linecap:round;
    stroke-linejoin:round;
    transition:stroke 0.15s, fill 0.15s;
    flex-shrink:0;
    display:block;
  }
  .action-btn-art .action-num {
    font-size:17px;
    font-weight:500;
    color:#4a4a4a;
    min-width:12px;
    display:inline-block;
    line-height:1;
  }
  .action-btn-art.loved svg { fill:#e74c3c; stroke:#e74c3c; }
  .action-btn-art.loved .action-num { color:#e74c3c; }

  .related-box { margin:32px 0 0; padding-top:22px; border-top:1px solid #eee; }
  .related-box h3 { font-size:18px; margin:0 0 14px; color:#111; font-weight:700; }
  .related-box ul { list-style:none; padding:0; margin:0; }
  .related-box li { margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid #f5f5f5; }
  .related-box a { color:#111; text-decoration:none; font-size:15px; line-height:1.55; font-weight:600; }
  .related-box a:hover { color:#007bff; }

  .article-footer { margin:36px 16px 0; padding-top:22px; border-top:1px solid #eee; text-align:center; color:#888; font-size:13px; }
  .article-footer a { color:#555; text-decoration:none; font-weight:600; letter-spacing:0.5px; }
  .article-footer a:hover { color:#007bff; }

  #artCommentModal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:2000; align-items:center; justify-content:center; padding:16px; }
  #artCommentModal.active { display:flex; }
  #artCommentModal .modal-box { background:#fff; border-radius:12px; width:100%; max-width:520px; max-height:85vh; display:flex; flex-direction:column; overflow:hidden; }
  #artCommentModal .modal-header { display:flex; justify-content:space-between; align-items:center; padding:14px 16px; border-bottom:1px solid #eee; }
  #artCommentModal .modal-header h3 { font-size:17px; font-weight:700; margin:0; }
  #artCommentModal .modal-close { background:none; border:none; font-size:26px; cursor:pointer; color:#888; line-height:1; padding:0 6px; }
  #artCommentModal .modal-list { padding:14px 16px; overflow-y:auto; flex:1; -webkit-overflow-scrolling:touch; }
  #artCommentModal .modal-form { padding:12px 16px; border-top:1px solid #eee; background:#fafafa; }
  #artCommentModal .modal-form input,
  #artCommentModal .modal-form textarea { width:100%; padding:9px 12px; border:1px solid #ddd; border-radius:6px; margin-bottom:8px; font-size:14px; outline:none; font-family:inherit; }
  #artCommentModal .modal-form textarea { height:70px; resize:vertical; }
  #artCommentModal .modal-form button { background:#000; color:#fff; border:none; padding:10px 20px; border-radius:6px; font-weight:600; cursor:pointer; font-size:14px; }

  @media (max-width:480px) {
    .header { padding:8px 12px; min-height:54px; }
    .header-title { font-size:20px; }
    .header-logo { height:24px; }
    .back-btn { width:32px; height:32px; }
    .back-btn svg { width:20px; height:20px; }
    .header-right { gap:6px; }
    .font-btn { width:34px; height:34px; font-size:13px; }
    .article-main { padding:12px; }
    .article-h1 { font-size:21px; }
    .article-body { font-size:16px; }
    .article-source-link { font-size:15px; }
    .article-date { font-size:13px; }
    .article-actions-row { gap:36px; padding:16px 0 12px; }
    .action-btn-art svg { width:30px; height:30px; }
    .action-btn-art .action-num { font-size:16px; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <a href="https://ajkernews.in/" class="back-btn" aria-label="Back to home">
      <svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
    </a>
    <img src="/logo.png" class="header-logo" alt="Ajker News">
    <span class="header-title">আজকের নিউজ</span>
  </div>
  <div class="header-right">
    <div class="font-controls">
      <button type="button" class="font-btn" id="fontDec" aria-label="Smaller">A-</button>
      <button type="button" class="font-btn" id="fontInc" aria-label="Bigger">A+</button>
    </div>
  </div>
</div>

<main class="article-main">
  <article itemscope itemtype="https://schema.org/NewsArticle">
    <meta itemprop="datePublished" content="${escapeHtml(publishedAt)}">
    <meta itemprop="dateModified" content="${escapeHtml(publishedAt)}">
    <meta itemprop="mainEntityOfPage" content="${escapeHtml(canonical)}">

    <a class="article-cat" href="https://ajkernews.in/?category=${encodeURIComponent(category)}">${escapeHtml(catLabel[category] || category)}</a>
    <h1 class="article-h1" itemprop="headline">${escapeHtml(title)}</h1>

    <div itemprop="image" itemscope itemtype="https://schema.org/ImageObject">
      <img itemprop="url" class="article-img" src="${escapeHtml(image)}" alt="${escapeHtml(title)}" width="1200" height="675" loading="eager" decoding="async">
    </div>

    <div class="article-body" id="articleBody" itemprop="articleBody">
      <p>${escapeHtml(fullSummary)}</p>
    </div>

    <div class="article-source-row">
      <a class="article-source-link" href="${escapeHtml(result.source_url || '#')}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(sourceDomain)}</a>
      <span class="article-date">${escapeHtml(formattedDate)}</span>
    </div>

    <div class="article-actions-row">
      <!-- Comment Icon — rounded bubble with left tail (exact image match) -->
      <button type="button" class="action-btn-art" id="artCommentBtn" aria-label="Comment">
        <svg viewBox="0 0 32 32" fill="none" stroke="#4a4a4a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 3.5c-7.18 0-13 4.93-13 11 0 3.4 1.82 6.43 4.71 8.47-.24 2.17-1 4.22-2.21 6.03-.26.4.15.87.58.68 2.55-1.11 4.73-2.6 6.4-4.17 1.1.22 2.27.34 3.52.34 7.18 0 13-4.93 13-11S23.18 3.5 16 3.5z"/>
        </svg>
      </button>

      <!-- Heart Icon — outline, exact image match -->
      <button type="button" class="action-btn-art" id="artLoveBtn" aria-label="Love">
        <svg viewBox="0 0 32 32" fill="none" stroke="#4a4a4a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 27.5S4 20 4 11.8C4 7.6 7.5 4.5 11.8 4.5c2.5 0 4.8 1.3 6.2 3.4l-2 1.6 2-1.6c1.4-2.1 3.7-3.4 6.2-3.4 4.3 0 7.8 3.1 7.8 7.3C28 20 16 27.5 16 27.5z"/>
        </svg>
        <span class="action-num" id="artLoveCount">${loveCount}</span>
      </button>

      <!-- Share Icon — 3 circles + 2 lines (exact image match) -->
      <button type="button" class="action-btn-art" id="artShareBtn" aria-label="Share">
        <svg viewBox="0 0 32 32" fill="none" stroke="#4a4a4a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="24" cy="6" r="4"/>
          <circle cx="8" cy="16" r="4"/>
          <circle cx="24" cy="26" r="4"/>
          <line x1="11.2" y1="14.2" x2="20.8" y2="7.8"/>
          <line x1="11.2" y1="17.8" x2="20.8" y2="24.2"/>
        </svg>
      </button>
    </div>
  </article>

  ${relatedHtml}
</main>

<footer class="article-footer">
  <p><a href="https://ajkernews.in/">HOME</a></p>
  <p style="margin-top:10px;">&copy; ${new Date().getFullYear()} Ajker News. All rights reserved.</p>
</footer>

<div id="artCommentModal">
  <div class="modal-box">
    <div class="modal-header">
      <h3>মন্তব্য</h3>
      <button type="button" class="modal-close" id="artModalClose">&times;</button>
    </div>
    <div class="modal-list" id="artCommentsList"></div>
    <div class="modal-form">
      <input type="text" id="artCommentAuthor" placeholder="আপনার নাম (ঐচ্ছিক)">
      <textarea id="artCommentText" placeholder="আপনার মন্তব্য লিখুন..."></textarea>
      <button type="button" id="artCommentSubmit">পাঠান</button>
    </div>
  </div>
</div>

<script>
(function() {
  var API_BASE = 'https://ajkernews.in';
  var NEWS_ID = ${JSON.stringify(safeId)};

  var sizes = [15, 16, 17, 18, 19, 20, 22, 24, 26, 28];
  var current = 2;
  try {
    var saved = parseInt(localStorage.getItem('articleFontSize') || '2', 10);
    if (!isNaN(saved) && saved >= 0 && saved < sizes.length) current = saved;
  } catch (e) {}

  function applyFont() {
    var body = document.getElementById('articleBody');
    if (body) body.style.fontSize = sizes[current] + 'px';
    try { localStorage.setItem('articleFontSize', String(current)); } catch (e) {}
  }
  function changeFont(delta) {
    current = Math.max(0, Math.min(sizes.length - 1, current + delta));
    applyFont();
  }

  var fontDecBtn = document.getElementById('fontDec');
  var fontIncBtn = document.getElementById('fontInc');
  if (fontDecBtn) fontDecBtn.addEventListener('click', function(e) { e.preventDefault(); changeFont(-1); });
  if (fontIncBtn) fontIncBtn.addEventListener('click', function(e) { e.preventDefault(); changeFont(1); });
  applyFont();

  var LOVED_KEY = 'loved:' + NEWS_ID;
  var DEVICE_KEY = 'deviceId';

  function getDeviceId() {
    try {
      var id = localStorage.getItem(DEVICE_KEY);
      if (!id) {
        id = 'user-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);
        localStorage.setItem(DEVICE_KEY, id);
      }
      return id;
    } catch (e) { return 'user-anonymous'; }
  }
  function isLoved() {
    try { return localStorage.getItem(LOVED_KEY) === '1'; } catch (e) { return false; }
  }
  function setLoved(v) {
    try {
      if (v) localStorage.setItem(LOVED_KEY, '1');
      else localStorage.removeItem(LOVED_KEY);
    } catch (e) {}
  }
  function updateLoveUI(loved, count) {
    var btn = document.getElementById('artLoveBtn');
    var countEl = document.getElementById('artLoveCount');
    if (btn) btn.classList.toggle('loved', !!loved);
    if (countEl && count !== undefined && count !== null) countEl.textContent = String(count);
  }

  updateLoveUI(isLoved());

  (async function() {
    try {
      var res = await fetch(API_BASE + '/api/love-counts?ids=' + encodeURIComponent(NEWS_ID));
      var data = await res.json();
      if (data && data.success && data.counts && typeof data.counts[NEWS_ID] === 'number') {
        updateLoveUI(isLoved(), data.counts[NEWS_ID]);
      }
    } catch (e) {}
  })();

  var loveBtn = document.getElementById('artLoveBtn');
  if (loveBtn) {
    loveBtn.addEventListener('click', async function(e) {
      e.preventDefault();
      var currentlyLoved = isLoved();
      var newLoved = !currentlyLoved;
      var countEl = document.getElementById('artLoveCount');
      var currentCount = countEl ? parseInt(countEl.textContent, 10) || 0 : 0;
      var newCount = newLoved ? currentCount + 1 : Math.max(0, currentCount - 1);

      setLoved(newLoved);
      updateLoveUI(newLoved, newCount);

      try {
        var res = await fetch(API_BASE + '/api/love', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: NEWS_ID, deviceId: getDeviceId() })
        });
        var data = await res.json();
        if (data && typeof data.love_count === 'number') {
          updateLoveUI(newLoved, data.love_count);
        }
      } catch (e) {}
    });
  }

  var commentModal = document.getElementById('artCommentModal');
  var commentBtn = document.getElementById('artCommentBtn');
  var modalClose = document.getElementById('artModalClose');
  var commentSubmit = document.getElementById('artCommentSubmit');

  function openComments() {
    if (commentModal) commentModal.classList.add('active');
    loadComments();
  }
  function closeComments() {
    if (commentModal) commentModal.classList.remove('active');
  }

  if (commentBtn) commentBtn.addEventListener('click', function(e) { e.preventDefault(); openComments(); });
  if (modalClose) modalClose.addEventListener('click', closeComments);
  if (commentModal) {
    commentModal.addEventListener('click', function(e) {
      if (e.target === commentModal) closeComments();
    });
  }

  async function loadComments() {
    var list = document.getElementById('artCommentsList');
    if (!list) return;
    list.innerHTML = '<p style="color:#888;text-align:center;padding:12px;">লোড হচ্ছে...</p>';
    try {
      var res = await fetch(API_BASE + '/api/comments?id=' + encodeURIComponent(NEWS_ID));
      var data = await res.json();
      var comments = (data && data.comments) || [];
      if (!comments.length) {
        list.innerHTML = '<p style="color:#888;text-align:center;padding:12px;">এখনো কোনো মন্তব্য নেই। প্রথম মন্তব্য করুন!</p>';
        return;
      }
      list.innerHTML = comments.map(function(c) {
        return '<div style="border-bottom:1px solid #f0f0f0;padding:10px 0;"><strong style="font-size:14px;">' + escapeHtml(c.author_name) + '</strong><p style="margin:5px 0 0;font-size:14px;color:#444;">' + escapeHtml(c.comment_text) + '</p></div>';
      }).join('');
    } catch (e) {
      list.innerHTML = '<p style="color:#888;text-align:center;padding:12px;">মন্তব্য লোড করা যায়নি।</p>';
    }
  }

  if (commentSubmit) {
    commentSubmit.addEventListener('click', async function(e) {
      e.preventDefault();
      var authorEl = document.getElementById('artCommentAuthor');
      var textEl = document.getElementById('artCommentText');
      var author = (authorEl && authorEl.value || '').trim() || 'Guest';
      var text = (textEl && textEl.value || '').trim();
      if (!text) { alert('মন্তব্য লিখুন!'); return; }
      try {
        var res = await fetch(API_BASE + '/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newsId: NEWS_ID, author: author, text: text })
        });
        if (res.ok) {
          if (textEl) textEl.value = '';
          await loadComments();
        } else {
          alert('মন্তব্য পাঠানো যায়নি');
        }
      } catch (e) {
        alert('মন্তব্য পাঠানো যায়নি');
      }
    });
  }

  var shareBtn = document.getElementById('artShareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', async function(e) {
      e.preventDefault();
      var shareUrl = API_BASE + '/news/' + encodeURIComponent(NEWS_ID);
      var headline = document.querySelector('.article-h1');
      var headlineText = headline ? headline.textContent.trim() : 'খবর';
      var text = headlineText + '\n\n' + shareUrl;

      if (navigator.share) {
        try {
          await navigator.share({ title: headlineText, text: text, url: shareUrl });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          alert('লিংক কপি হয়েছে');
          return;
        }
      } catch (err) {}
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert('লিংক কপি হয়েছে');
      } catch (err) {
        prompt('লিংক কপি করুন:', text);
      }
    });
  }

  function escapeHtml(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
})();
</script>
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
 * TABLES SETUP
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
 * PUSH NOTIFICATIONS
 * ========================================================= */
async function handleSubscribe(request, env) {
  try {
    const body = await request.json();
    const token = body?.token || body?.endpoint;
    if (!token) return json({ success: false, error: "Token required" }, 400, 0);

    const endpoint = body?.endpoint || `fcm:${token.slice(0, 32)}`;
    const keys = JSON.stringify(body?.keys || {});
    const now = new Date().toISOString();

    const existing = await env.DB.prepare(
      `SELECT id FROM push_subscriptions WHERE token = ? OR endpoint = ? LIMIT 1`
    ).bind(token, endpoint).first();

    if (existing) {
      await env.DB.prepare(`UPDATE push_subscriptions SET token = ?, keys_json = ? WHERE id = ?`).bind(token, keys, existing.id).run();
      return json({ success: true, message: "Updated" }, 200, 0);
    }

    await env.DB.prepare(`INSERT INTO push_subscriptions (id, endpoint, keys_json, token, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), endpoint, keys, token, now).run();

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

async function queueAndSendPushNotifications(env, newsIds) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return;
  const ids = [...new Set((newsIds || []).filter(Boolean))];
  if (!ids.length) return;

  const placeholders = ids.map(() => "?").join(",");
  const latestNews = await env.DB.prepare(`
    SELECT id, headline, summary, image_url FROM news
    WHERE id IN (${placeholders}) AND status = 'published'
    ORDER BY created_at DESC, score DESC LIMIT 1
  `).bind(...ids).first();

  if (!latestNews) return;

  const subs = await env.DB.prepare(
    `SELECT token FROM push_subscriptions WHERE token IS NOT NULL AND token != '' ORDER BY created_at DESC LIMIT 500`
  ).all();

  if (!subs.results?.length) return;

  const tokens = subs.results.map(s => s.token).filter(Boolean);
  console.log(`[PUSH-FCM] Sending to ${tokens.length} subscribers`);

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) { return; }

  const fcm = new FCM(new FcmOptions({ serviceAccount }));
  const targetUrl = `https://ajkernews.in/news/${latestNews.id}`;
  const title = String(latestNews.headline || "নতুন খবর").slice(0, 180);
  const body = String(latestNews.summary || "বিস্তারিত জানতে ক্লিক করুন").slice(0, 180);

  try {
    const unregisteredTokens = await fcm.sendToTokens({
      notification: { title, body },
      data: { url: targetUrl, image: latestNews.image_url || "", notificationId: `news:${latestNews.id}` },
      webpush: {
        notification: {
          icon: "https://ajkernews.in/logo.png",
          badge: "https://ajkernews.in/logo.png",
          image: latestNews.image_url || undefined
        },
        fcmOptions: { link: targetUrl }
      }
    }, tokens);

    if (unregisteredTokens && unregisteredTokens.length > 0) {
      const cleanPlaceholders = unregisteredTokens.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM push_subscriptions WHERE token IN (${cleanPlaceholders})`).bind(...unregisteredTokens).run();
    }
  } catch (error) {
    console.error("[PUSH-FCM] Send failed:", error?.message || String(error));
  }
}

async function handlePushSync(request, env) {
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
 * SITEMAP / RSS / ROBOTS
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
      headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "public, max-age=300, s-maxage=600", ...corsHeaders() }
    });
  } catch (error) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://ajkernews.in/</loc></url></urlset>`, {
      status: 200, headers: { "Content-Type": "application/xml; charset=UTF-8" }
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
      headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "public, max-age=300, s-maxage=600", ...corsHeaders() }
    });
  } catch (error) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"></urlset>`, {
      status: 200, headers: { "Content-Type": "application/xml; charset=UTF-8" }
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
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "public, max-age=3600, s-maxage=3600" }
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
    headers: { "Content-Type": "application/rss+xml; charset=UTF-8", "Cache-Control": "public, max-age=300, s-maxage=600" }
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
