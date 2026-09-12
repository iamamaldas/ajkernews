/**
 * =========================================================
 * AJKER NEWS - CLOUDFLARE WORKER
 * FINAL v6 — Modular pipeline (3 bn + 3 en per slot)
 * =========================================================
 */

import webPush from "web-push";
import ANALYTICS_CONFIG from "./config-analytics.js";
import ADS_CONFIG from "./config-ads.js";
import AFFILIATE_CONFIG from "./config-affiliate.js";
import { processSelectedNews } from "./gemini.js";
import { runGNewsBatch } from "./news-fetcher.js";
import { selectBestCandidates, publishSelectedNews } from "./news-selector.js";
import { enforceNewsLimit } from "./cleanup.js";

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      await ensureTablesOnce(env);

      const userAgent = request.headers.get("User-Agent") || "";
      const isBot = /googlebot|bingbot|yandex|baiduspider|twitterbot|facebookexternalhit|whatsapp|slurp|duckduckbot|applebot/i.test(userAgent);

      if (url.pathname === "/" && isBot) {
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
        return await serveSharePage(id, env, request.headers.get("User-Agent") || "", url);
      }

      if (url.pathname === "/api/affiliate" && request.method === "GET") {
        return await handleAffiliate(url, env);
      }

      if (url.pathname === "/news" && url.searchParams.has("id")) {
        return await serveNewsPage(url, env);
      }

      if (url.pathname === "/sitemap.xml") {
        return await generateSitemap(env);
      }

      if (url.pathname === "/api/news") {
        return await handleGetNews(url, env);
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
        return json({ success: true, publicKey: env.VAPID_PUBLIC_KEY || "" }, 200, 300);
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
    console.log("Scheduled task started:", new Date(event.scheduledTime).toISOString());

    try {
      const result = await updateNews(env);
      console.log("Scheduled task completed:", JSON.stringify(result));

      if (result.published > 0 && Array.isArray(result.newNewsIds) && result.newNewsIds.length) {
        ctx.waitUntil(
          queueAndSendPushNotifications(env, result.newNewsIds).catch(error => {
            console.error("Push queue error:", error?.message || String(error));
          })
        );
      }

      ctx.waitUntil(
        cleanExpiredPushNotifications(env).catch(error => {
          console.error("Push cleanup error:", error?.message || String(error));
        })
      );
    } catch (error) {
      console.error("Scheduled task failed:", error?.message || error?.stack || String(error));
    }
  }
};

/* =========================================================
 * NEW MODULAR PIPELINE
 * ========================================================= */

async function updateNews(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  if (!env.GNEWS_API_KEY) throw new Error("GNEWS_API_KEY secret is missing");

  // 1. Fetch GNews bn + en → store as candidates
  let batchResult = { batches: [], totalReceived: 0, totalInserted: 0 };
  try {
    batchResult = await runGNewsBatch(env.DB, env.GNEWS_API_KEY);
    console.log(`[NEWS] GNews batches:`, JSON.stringify(batchResult));
  } catch (error) {
    console.error("[NEWS] GNews batch failed:", error?.message || String(error));
    return {
      success: false,
      fetched: 0,
      inserted: 0,
      candidates: 0,
      selected: 0,
      published: 0,
      deleted: 0,
      gemini: false,
      newNewsIds: [],
      message: "GNews fetch failed: " + (error?.message || String(error))
    };
  }

  // 2. Fetch all candidates
  const candidatesResult = await env.DB.prepare(
    `SELECT * FROM news WHERE status = 'candidate' ORDER BY published_at DESC LIMIT 200`
  ).all();
  const candidates = candidatesResult.results || [];

  if (candidates.length === 0) {
    return {
      success: true,
      fetched: batchResult.totalReceived,
      inserted: batchResult.totalInserted,
      candidates: 0,
      selected: 0,
      published: 0,
      deleted: 0,
      gemini: false,
      newNewsIds: [],
      message: "No candidates available"
    };
  }

  // 3. Existing published for similarity check
  const publishedResult = await env.DB.prepare(
    `SELECT source_title, headline FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 50`
  ).all();
  const existingPublished = publishedResult.results || [];

  // 4. Select best: 3 bn + 3 en
  const selected = selectBestCandidates(candidates, existingPublished);

  if (selected.length === 0) {
    return {
      success: true,
      fetched: batchResult.totalReceived,
      inserted: batchResult.totalInserted,
      candidates: candidates.length,
      selected: 0,
      published: 0,
      deleted: 0,
      gemini: false,
      newNewsIds: [],
      message: "No selectable news"
    };
  }

  // 5. Gemini
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
        language: c.language || "en"
      }));

      geminiResults = await processSelectedNews(geminiInput, env.GEMINI_API_KEY);
      usedGemini = Array.isArray(geminiResults) && geminiResults.length > 0;
      console.log(`[NEWS] Gemini returned ${geminiResults.length} results`);
    } catch (error) {
      console.error("[NEWS] Gemini failed:", error?.message || String(error));
    }
  }

  if (!geminiResults.length) {
    return {
      success: true,
      fetched: batchResult.totalReceived,
      inserted: batchResult.totalInserted,
      candidates: candidates.length,
      selected: selected.length,
      published: 0,
      deleted: 0,
      gemini: false,
      newNewsIds: [],
      message: "Gemini returned no valid results"
    };
  }

  // 6. Publish selected
  const publishResult = await publishSelectedNews(env.DB, selected, geminiResults);
  console.log(`[NEWS] Published ${publishResult.published} news`);

  // 7. Update search_text for published articles
  const publishedIds = geminiResults.map(r => r.id).filter(Boolean);
  for (const id of publishedIds) {
    const row = await env.DB.prepare(
      `SELECT headline, summary, main_topic, category FROM news WHERE id = ? AND status = 'published'`
    ).bind(id).first();

    if (!row) continue;

    const searchText = toTransliterated(
      [row.headline, row.summary, row.main_topic, row.category].filter(Boolean).join(" ")
    );

    await env.DB.prepare(`UPDATE news SET search_text = ? WHERE id = ?`)
      .bind(searchText, id).run();
  }

  // 8. Enforce storage limit 1000
  const cleanupResult = await enforceNewsLimit(env.DB);
  console.log(`[NEWS] Cleanup: deleted ${cleanupResult.deleted}, total ${cleanupResult.total}`);

  // 9. Clean orphan loves/comments
  for (const id of cleanupResult.deletedIds || []) {
    try {
      await env.DB.prepare(`DELETE FROM news_loves WHERE news_id = ?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM news_comments WHERE news_id = ?`).bind(id).run();
    } catch (e) { /* ignore */ }
  }

  return {
    success: true,
    fetched: batchResult.totalReceived,
    inserted: batchResult.totalInserted,
    candidates: candidates.length,
    selected: selected.length,
    published: publishResult.published,
    deleted: cleanupResult.deleted,
    gemini: usedGemini,
    newNewsIds: publishedIds,
    message: `Update completed. ${publishResult.published} published, ${cleanupResult.deleted} cleaned.`
  };
}

/* =========================================================
 * SEO / PUBLIC PAGES
 * ========================================================= */

async function serveBotHomepage(env) {
  try {
    const result = await env.DB.prepare(
      `SELECT id, headline, summary, published_at, category, image_url FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 20`
    ).all();

    const news = result.results || [];
    let newsHtml = "";

    for (const item of news) {
      const link = `https://ajkernews.in/?id=${encodeURIComponent(item.id)}`;
      newsHtml += `
        <article style="margin-bottom: 20px;">
          <h2><a href="${link}">${escapeHtml(item.headline)}</a></h2>
          <p>${escapeHtml((item.summary || "").substring(0, 300))}...</p>
          <small>প্রকাশিত: ${escapeHtml(item.published_at || "")}</small>
        </article>
      `;
    }

    const html = `<!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>আজকের নিউজ | কলকাতা, পশ্চিমবঙ্গ ও ভারতের সর্বশেষ খবর</title>
      <meta name="description" content="কলকাতা, পশ্চিমবঙ্গ এবং ভারতের সর্বশেষ খবর পড়ুন আজকের নিউজে। প্রতিদিনের আপডেট বাংলায়।">
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "আজকের নিউজ",
        "url": "https://ajkernews.in/"
      }
      </script>
    </head>
    <body>
      <header><h1>আজকের নিউজ</h1></header>
      <main>${newsHtml}</main>
      <footer><p>&copy; 2026 Ajker News</p></footer>
    </body>
    </html>`;

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "public, max-age=300" }
    });
  } catch (error) {
    console.error("Bot homepage error:", error?.message || error?.stack || String(error));
    return new Response("Error loading content", { status: 500 });
  }
}

async function ensureTables(env) {
  const queries = [
    `CREATE TABLE IF NOT EXISTS news (id TEXT PRIMARY KEY, source_url TEXT UNIQUE, source_name TEXT, source_title TEXT, source_description TEXT, headline TEXT, summary TEXT, main_topic TEXT, category TEXT, image_url TEXT, published_at TEXT, created_at TEXT, day_key TEXT, status TEXT DEFAULT 'published', score INTEGER DEFAULT 0, search_text TEXT, indexed_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS news_loves (id INTEGER PRIMARY KEY AUTOINCREMENT, news_id TEXT, device_id TEXT, UNIQUE(news_id, device_id))`,
    `CREATE TABLE IF NOT EXISTS news_comments (id TEXT PRIMARY KEY, news_id TEXT, author_name TEXT, comment_text TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, endpoint TEXT UNIQUE, keys_json TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS push_notifications (id TEXT PRIMARY KEY, news_id TEXT, title TEXT, body TEXT, url TEXT, created_at TEXT, expires_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS push_notification_deliveries (id TEXT PRIMARY KEY, notification_id TEXT, endpoint TEXT, created_at TEXT, last_sent_at TEXT, status TEXT DEFAULT 'pending', UNIQUE(notification_id, endpoint))`,
    `CREATE INDEX IF NOT EXISTS idx_push_notifications_expires ON push_notifications(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_push_delivery_endpoint ON push_notification_deliveries(endpoint, status)`,
    `CREATE TABLE IF NOT EXISTS affiliate_clicks (id TEXT PRIMARY KEY, affiliate_name TEXT, click_url TEXT, device_id TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS indexing_log (id TEXT PRIMARY KEY, news_id TEXT, url TEXT, status TEXT, response TEXT, created_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_news_status_published ON news(status, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_category_published ON news(category, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_score_published ON news(score DESC, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_loves_news_id ON news_loves(news_id)`,
    `CREATE INDEX IF NOT EXISTS idx_news_comments_news_created ON news_comments(news_id, created_at ASC)`
  ];

  for (const sql of queries) {
    try {
      await env.DB.prepare(sql).run();
    } catch (error) {
      console.error("Table setup error:", error?.message || String(error));
    }
  }

  // Migration: add "language" column if missing
  try {
    const columns = await env.DB.prepare(`PRAGMA table_info(news)`).all();
    const hasLanguage = (columns.results || []).some(c => c.name === "language");
    if (!hasLanguage) {
      console.log("[MIGRATION] Adding language column to news table");
      await env.DB.prepare(`ALTER TABLE news ADD COLUMN language TEXT DEFAULT 'bn'`).run();
    }
  } catch (error) {
    console.error("Language column migration failed:", error?.message || String(error));
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

  const result = await env.DB.prepare(`SELECT headline, summary FROM news WHERE id = ? AND status = 'published' LIMIT 1`).bind(safeId).first();
  if (!result) return Response.redirect("https://ajkernews.in/", 302);

  const openModalParam = (requestUrl && requestUrl.searchParams.get("openModal") === "true") ? "&openModal=true" : "";
  const homeUrl = `https://ajkernews.in/?shared=${encodeURIComponent(safeId)}${openModalParam}`;

  const html = `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><script>window.location.replace(${JSON.stringify(homeUrl)});</script></head><body><noscript><a href="${escapeHtml(homeUrl)}">পূর্ণ খবর দেখতে এই লিঙ্কে ক্লিক করুন</a></noscript></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...corsHeaders()
    }
  });
}

async function serveNewsPage(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return Response.redirect("https://ajkernews.in/", 302);

  const result = await env.DB.prepare(`SELECT headline, summary, image_url, published_at, source_name FROM news WHERE id = ? AND status = 'published' LIMIT 1`).bind(id).first();
  if (!result) return Response.redirect("https://ajkernews.in/", 302);

  const title = cleanText(result.headline) || "Ajker News";
  const description = cleanText(result.summary || "").slice(0, 160);
  const image = result.image_url || "https://ajkernews.in/logo.png";
  const publishedAt = result.published_at || new Date().toISOString();
  const homeUrl = `https://ajkernews.in/?shared=${encodeURIComponent(id)}`;

  const newsArticleLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": title,
    "description": description,
    "image": [image],
    "datePublished": publishedAt,
    "dateModified": publishedAt,
    "author": { "@type": "Organization", "name": "Ajker News" },
    "publisher": {
      "@type": "Organization",
      "name": "Ajker News",
      "logo": { "@type": "ImageObject", "url": "https://ajkernews.in/logo.png" }
    },
    "mainEntityOfPage": { "@type": "WebPage", "@id": `https://ajkernews.in/?id=${encodeURIComponent(id)}` }
  });

  let html = `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - Ajker News</title><meta name="description" content="${escapeHtml(description)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(homeUrl)}"><meta property="og:type" content="article"><meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(image)}"><script type="application/ld+json">${newsArticleLd}</script><meta http-equiv="refresh" content="0;url=${escapeHtml(homeUrl)}"><script>window.location.replace(${JSON.stringify(homeUrl)});</script></head><body><p>${escapeHtml(title)}</p></body></html>`;

  const analyticsScript = `<script async src="https://www.googletagmanager.com/gtag/js?id=${escapeHtml(ANALYTICS_CONFIG.gaTrackingId)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config",${JSON.stringify(ANALYTICS_CONFIG.gaTrackingId)});</script>${ANALYTICS_CONFIG.extraHeadScripts || ""}${ADS_CONFIG.adNetworkScripts || ""}`;

  html = html.replace("</head>", analyticsScript + "</head>");
  if (ADS_CONFIG.extraFooterScripts) {
    html = html.replace("</body>", ADS_CONFIG.extraFooterScripts + "</body>");
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
      ...corsHeaders()
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

async function handleGetNews(url, env) {
  const category = url.searchParams.get("category") || "top";
  const query = (url.searchParams.get("q") || "").trim();
  const specificId = url.searchParams.get("id");
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const queryLimit = API_PAGE_SIZE + 1;

  const selectFields = `news.id, news.headline, news.summary, news.main_topic, news.category, news.image_url, news.published_at, news.source_name, news.source_url, news.created_at, news.score, (SELECT COUNT(*) FROM news_loves nl WHERE nl.news_id = news.id) AS love_count`;

  if (specificId) {
    const result = await env.DB.prepare(`SELECT ${selectFields} FROM news WHERE news.id = ? AND news.status = 'published' LIMIT 1`).bind(specificId).all();
    const news = result.results || [];
    return json({ success: true, count: news.length, news }, 200, 300);
  }

  let result;
  if (query) {
    const transliterated = toTransliterated(query);
    result = await env.DB.prepare(`SELECT ${selectFields} FROM news WHERE news.status = 'published' AND (news.search_text LIKE ? OR news.headline LIKE ? OR news.summary LIKE ? OR news.main_topic LIKE ?) ORDER BY news.published_at DESC LIMIT ? OFFSET ?`)
      .bind(`%${transliterated}%`, `%${query}%`, `%${query}%`, `%${query}%`, queryLimit, offset).all();
  } else if (category === "trending") {
    result = await env.DB.prepare(`SELECT ${selectFields} FROM news WHERE news.status = 'published' ORDER BY news.score DESC, news.published_at DESC LIMIT ? OFFSET ?`).bind(queryLimit, offset).all();
  } else if (category !== "top" && category !== "all") {
    result = await env.DB.prepare(`SELECT ${selectFields} FROM news WHERE news.status = 'published' AND news.category = ? ORDER BY news.published_at DESC LIMIT ? OFFSET ?`).bind(category, queryLimit, offset).all();
  } else {
    result = await env.DB.prepare(`SELECT ${selectFields} FROM news WHERE news.status = 'published' ORDER BY news.published_at DESC LIMIT ? OFFSET ?`).bind(queryLimit, offset).all();
  }

  const rawNews = result?.results || [];
  const hasMore = rawNews.length > API_PAGE_SIZE;
  const news = rawNews.slice(0, API_PAGE_SIZE);

  return json({ success: true, count: news.length, offset, limit: API_PAGE_SIZE, has_more: hasMore, news }, 200, 30);
}

/* =========================================================
 * PUSH NOTIFICATIONS
 * ========================================================= */

async function handleSubscribe(request, env) {
  try {
    const subscription = await request.json();
    if (!subscription?.endpoint) {
      return json({ success: false, error: "Invalid subscription" }, 400, 0);
    }

    const endpoint = subscription.endpoint;
    const keys = JSON.stringify(subscription.keys || {});

    const existing = await env.DB.prepare(`SELECT id FROM push_subscriptions WHERE endpoint = ? LIMIT 1`).bind(endpoint).first();
    if (existing) {
      await env.DB.prepare(`UPDATE push_subscriptions SET keys_json = ? WHERE endpoint = ?`).bind(keys, endpoint).run();
      return json({ success: true, message: "Subscription updated" }, 200, 0);
    }

    await env.DB.prepare(`INSERT INTO push_subscriptions (id, endpoint, keys_json, created_at) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), endpoint, keys, new Date().toISOString()).run();

    return json({ success: true }, 200, 0);
  } catch (error) {
    console.error("Subscribe error:", error?.message || String(error));
    return json({ success: false, error: error?.message || "Subscribe error" }, 500, 0);
  }
}

async function handleUnsubscribe(request, env) {
  try {
    const { endpoint } = await request.json();
    if (!endpoint) return json({ error: "Missing endpoint" }, 400, 0);

    const result = await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
    if (result.meta?.rows_written > 0) {
      return json({ success: true, message: "Unsubscribed successfully" }, 200, 0);
    } else {
      return json({ success: false, message: "Subscription not found" }, 404, 0);
    }
  } catch (error) {
    console.error("Unsubscribe error:", error?.message || String(error));
    return json({ success: false, error: error?.message || "Unsubscribe error" }, 500, 0);
  }
}

async function cleanExpiredPushNotifications(env) {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`DELETE FROM push_notification_deliveries WHERE notification_id IN (SELECT id FROM push_notifications WHERE expires_at <= ?)`).bind(now).run();
    await env.DB.prepare(`DELETE FROM push_notifications WHERE expires_at <= ?`).bind(now).run();
  } catch (error) {
    console.error("Push expiry cleanup failed:", error?.message || String(error));
  }
}

async function queueAndSendPushNotifications(env, newsIds) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn("VAPID keys are missing.");
    return;
  }

  const ids = [...new Set((newsIds || []).filter(Boolean))];
  if (!ids.length) return;

  await cleanExpiredPushNotifications(env);

  webPush.setVapidDetails(
    env.VAPID_EMAIL || "mailto:info@ajkernews.in",
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  const subs = await env.DB.prepare(`SELECT endpoint, keys_json FROM push_subscriptions`).all();
  if (!subs.results?.length) return;

  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  for (const newsId of ids) {
    const news = await env.DB.prepare(`SELECT id, headline, summary FROM news WHERE id = ? AND status = 'published' LIMIT 1`).bind(newsId).first();
    if (!news) continue;

    const notificationId = `news:${news.id}`;
    const title = "নতুন খবর!";
    const body = cleanText(news.headline || news.summary || "আজকের নতুন খবর দেখুন।").slice(0, 180);
    const targetUrl = `https://ajkernews.in/go/${encodeURIComponent(news.id)}`;

    await env.DB.prepare(`INSERT OR IGNORE INTO push_notifications (id, news_id, title, body, url, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(notificationId, news.id, title, body, targetUrl, now.toISOString(), expires).run();

    for (const sub of subs.results) {
      await env.DB.prepare(`INSERT OR IGNORE INTO push_notification_deliveries (id, notification_id, endpoint, created_at, status) VALUES (?, ?, ?, ?, 'pending')`)
        .bind(crypto.randomUUID(), notificationId, sub.endpoint, now.toISOString()).run();
    }
  }

  await sendPendingPushNotifications(env);
}

async function sendPendingPushNotifications(env, endpointFilter = null) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  await cleanExpiredPushNotifications(env);
  webPush.setVapidDetails(
    env.VAPID_EMAIL || "mailto:info@ajkernews.in",
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  let query = `SELECT d.id AS delivery_id, d.endpoint, s.keys_json, n.id AS notification_id, n.title, n.body, n.url FROM push_notification_deliveries d JOIN push_notifications n ON n.id = d.notification_id JOIN push_subscriptions s ON s.endpoint = d.endpoint WHERE n.expires_at > ? AND d.status = 'pending'`;
  const binds = [new Date().toISOString()];

  if (endpointFilter) {
    query += ` AND d.endpoint = ?`;
    binds.push(endpointFilter);
  }
  query += ` ORDER BY n.created_at ASC`;

  const rows = await env.DB.prepare(query).bind(...binds).all();
  const list = rows.results || [];
  if (!list.length) return;

  await Promise.allSettled(
    list.map(async (row) => {
      try {
        const payload = JSON.stringify({
          title: row.title,
          body: row.body,
          url: row.url,
          notificationId: row.notification_id,
          icon: "/logo.png",
          badge: "/logo.png"
        });

        await webPush.sendNotification(
          { endpoint: row.endpoint, keys: JSON.parse(row.keys_json) },
          payload,
          {
            TTL: 86400,
            urgency: "high",
            headers: {
              "Topic": "ajker-news-" + row.notification_id,
              "Urgency": "high"
            }
          }
        );

        await env.DB.prepare(`UPDATE push_notification_deliveries SET last_sent_at = ?, status = 'sent' WHERE id = ?`)
          .bind(new Date().toISOString(), row.delivery_id).run();
      } catch (error) {
        const statusCode = error?.statusCode || 0;
        if ([401, 403, 404, 410].includes(statusCode)) {
          await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(row.endpoint).run();
          await env.DB.prepare(`DELETE FROM push_notification_deliveries WHERE endpoint = ?`).bind(row.endpoint).run();
        } else if (statusCode === 429) {
          // rate limited — skip
        } else {
          console.error("Push send failed:", statusCode, error?.message || String(error));
        }
      }
    })
  );
}

async function handlePushSync(request, env) {
  try {
    const subscription = await request.json();
    if (!subscription?.endpoint) return json({ success: false, error: "Invalid subscription" }, 400, 0);

    await handleSubscribe(new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription)
    }), env);

    await cleanExpiredPushNotifications(env);
    await sendPendingPushNotifications(env, subscription.endpoint);

    return json({ success: true, synced: true }, 200, 0);
  } catch (error) {
    console.error("Push sync error:", error?.message || String(error));
    return json({ success: false, error: error?.message || "Push sync error" }, 500, 0);
  }
}

/* =========================================================
 * LOVE + COMMENTS
 * ========================================================= */

async function toggleLove(request, env) {
  try {
    const { id, deviceId } = await request.json();
    if (!id || !deviceId) {
      return json({ error: "Missing id or deviceId" }, 400, 0);
    }

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
  return json({ comments: result.results || [] }, 200, 30);
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
 * GOOGLE INDEXING
 * ========================================================= */

async function requestGoogleIndexing(url, env) {
  try {
    const token = await getGoogleAccessToken(env);
    if (!token) return false;

    const response = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url, type: "URL_UPDATED" })
    });

    const responseText = await response.text();

    try {
      await env.DB.prepare(`INSERT INTO indexing_log (id, news_id, url, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), getIdFromNewsUrl(url), url, response.ok ? "success" : "failed", responseText, new Date().toISOString()).run();
    } catch (error) {
      console.error("Indexing log error:", error?.message || String(error));
    }

    return response.ok;
  } catch (error) {
    console.error("Indexing error:", error?.message || String(error));
    return false;
  }
}

function getIdFromNewsUrl(url) {
  try {
    return new URL(url).searchParams.get("id") || "unknown";
  } catch {
    return "unknown";
  }
}

async function getGoogleAccessToken(env) {
  try {
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;

    const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const now = Math.floor(Date.now() / 1000);

    const header = { alg: "RS256", typ: "JWT" };
    const claimSet = {
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/indexing",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
    const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(credentials.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signatureInput));
    const encodedSignature = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    const jwt = `${signatureInput}.${encodedSignature}`;

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.access_token || null;
  } catch (error) {
    console.error("Token generation error:", error?.message || String(error));
    return null;
  }
}

/* =========================================================
 * SITEMAP
 * ========================================================= */

async function generateSitemap(env) {
  const result = await env.DB.prepare(`SELECT id, created_at FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT ?`).bind(MAX_NEWS).all();
  const news = result.results || [];
  const baseUrl = "https://ajkernews.in";

  let xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`;

  for (const item of news) {
    const lastmod = item.created_at ? item.created_at.split("T")[0] : new Date().toISOString().split("T")[0];
    xml += `<url><loc>${baseUrl}/?id=${encodeURIComponent(item.id)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`;
  }

  xml += `</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "public, max-age=3600",
      ...corsHeaders()
    }
  });
}

/* =========================================================
 * HELPERS
 * ========================================================= */

function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const lines = String(pem || "").split("\n");
  let base64 = "";
  for (const line of lines) {
    if (!line.includes("-----")) base64 += line.trim();
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
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
