/**
 * =========================================================
 * AJKER NEWS - CLOUDFLARE WORKER
 * FINAL v10 — Assets + Bot SSR + Google Indexing API
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

const BOT_REGEX = /googlebot|bingbot|yandex|baiduspider|twitterbot|facebookexternalhit|whatsapp|slurp|duckduckbot|applebot|petalbot|semrushbot|ahrefsbot|lighthouse|chrome-lighthouse/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      await ensureTablesOnce(env);

      const userAgent = request.headers.get("User-Agent") || "";
      const isBot = BOT_REGEX.test(userAgent);

      if (url.pathname === "/" && request.method === "GET" && isBot) {
        const articleId = url.searchParams.get("id");
        if (articleId) {
          return await serveBotArticlePage(articleId, env);
        }
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
        return await serveNewsPage(url, env, request);
      }

      if (url.pathname === "/sitemap.xml") {
        return await generateSitemap(env);
      }

      if (url.pathname === "/news-sitemap.xml") {
        return await generateNewsSitemap(env);
      }

      if (url.pathname === "/rss.xml") {
        return await generateRSS(env);
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
        } else {
          ctx.waitUntil(
            sendPendingPushNotifications(env).catch(error =>
              console.error("Pending push error:", error?.message || String(error))
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

      // ✅ সবসময় pending পুশ পাঠান (নতুন খবর না থাকলেও)
      ctx.waitUntil(
        sendPendingPushNotifications(env).catch(error => {
          console.error("Pending push send error:", error?.message || String(error));
        })
      );

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
      published: 0, deleted: 0, indexed: 0, gemini: false, newNewsIds: [],
      message: "GNews fetch failed: " + (error?.message || String(error))
    };
  }

  const candidatesResult = await env.DB.prepare(
    `SELECT * FROM news WHERE status = 'candidate' ORDER BY published_at DESC LIMIT 200`
  ).all();
  const candidates = candidatesResult.results || [];

  if (candidates.length === 0) {
    return {
      success: true, fetched: batchResult.totalReceived, inserted: batchResult.totalInserted,
      candidates: 0, selected: 0, published: 0, deleted: 0, indexed: 0,
      gemini: false, newNewsIds: [], message: "No candidates available"
    };
  }

  const publishedResult = await env.DB.prepare(
    `SELECT source_title, headline FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 50`
  ).all();
  const existingPublished = publishedResult.results || [];

  const selected = selectBestCandidates(candidates, existingPublished);

  if (selected.length === 0) {
    return {
      success: true, fetched: batchResult.totalReceived, inserted: batchResult.totalInserted,
      candidates: candidates.length, selected: 0, published: 0, deleted: 0, indexed: 0,
      gemini: false, newNewsIds: [], message: "No selectable news"
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
      success: true, fetched: batchResult.totalReceived, inserted: batchResult.totalInserted,
      candidates: candidates.length, selected: selected.length, published: 0,
      deleted: 0, indexed: 0, gemini: false, newNewsIds: [],
      message: "Gemini returned no valid results"
    };
  }

  const publishResult = await publishSelectedNews(env.DB, selected, geminiResults);
  console.log(`[NEWS] Published ${publishResult.published} news`);

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

  let indexedCount = 0;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON && publishedIds.length > 0) {
    console.log(`[INDEXING] Submitting ${publishedIds.length} URLs to Google...`);
    for (const id of publishedIds) {
      const newsUrl = `https://ajkernews.in/?id=${encodeURIComponent(id)}`;
      try {
        const success = await requestGoogleIndexing(newsUrl, env);
        if (success) {
          indexedCount++;
          console.log(`[INDEXING] ✅ ${newsUrl}`);
        } else {
          console.warn(`[INDEXING] ❌ ${newsUrl}`);
        }
      } catch (error) {
        console.error(`[INDEXING] Error for ${newsUrl}:`, error?.message || String(error));
      }
    }
    console.log(`[INDEXING] Completed: ${indexedCount}/${publishedIds.length} submitted`);
  } else if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.warn("[INDEXING] GOOGLE_SERVICE_ACCOUNT_JSON not set — skipping Indexing API");
  }

  const cleanupResult = await enforceNewsLimit(env.DB);
  console.log(`[NEWS] Cleanup: deleted ${cleanupResult.deleted}, total ${cleanupResult.total}`);

  for (const id of cleanupResult.deletedIds || []) {
    try {
      await env.DB.prepare(`DELETE FROM news_loves WHERE news_id = ?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM news_comments WHERE news_id = ?`).bind(id).run();
    } catch (e) { /* ignore */ }
  }

  return {
    success: true, fetched: batchResult.totalReceived, inserted: batchResult.totalInserted,
    candidates: candidates.length, selected: selected.length, published: publishResult.published,
    deleted: cleanupResult.deleted, indexed: indexedCount, gemini: usedGemini,
    newNewsIds: publishedIds,
    message: `Update completed. ${publishResult.published} published, ${indexedCount} indexed, ${cleanupResult.deleted} cleaned.`
  };
}

/* =========================================================
 * BOT HOMEPAGE — rich schema + category nav
 * ========================================================= */
async function serveBotHomepage(env) {
  try {
    const newsResult = await env.DB.prepare(
      `SELECT id, headline, summary, published_at, category, image_url,
              source_name, main_topic
       FROM news
       WHERE status = 'published'
       ORDER BY published_at DESC
       LIMIT 100`
    ).all();
    const news = newsResult.results || [];

    const catResult = await env.DB.prepare(
      `SELECT category, COUNT(*) AS cnt FROM news
       WHERE status = 'published' AND category IS NOT NULL
       GROUP BY category ORDER BY cnt DESC LIMIT 20`
    ).all();
    const categories = catResult.results || [];

    const catLabel = {
      top:'সেরা খবর', trending:'ট্রেন্ডিং', west_bengal:'পশ্চিমবঙ্গ',
      kolkata:'কলকাতা', india:'ভারত', world:'বিশ্ব', business:'ব্যবসা',
      sports:'খেলা', politics:'রাজনীতি', technology:'প্রযুক্তি',
      entertainment:'বিনোদন', crime:'অপরাধ', district:'জেলা', general:'সাধারণ'
    };

    let newsHtml = "";
    for (const item of news) {
      const link = `https://ajkernews.in/?id=${encodeURIComponent(item.id)}`;
      const image = item.image_url || "https://ajkernews.in/logo.png";
      const publishedDate = item.published_at
        ? new Date(item.published_at).toISOString()
        : new Date().toISOString();
      const cat = catLabel[item.category] || item.category || 'সংবাদ';

      newsHtml += `
        <article itemscope itemtype="https://schema.org/NewsArticle"
                 style="margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #eee;">
          <meta itemprop="datePublished" content="${escapeHtml(publishedDate)}">
          <meta itemprop="dateModified" content="${escapeHtml(publishedDate)}">
          <meta itemprop="mainEntityOfPage" content="${escapeHtml(link)}">
          <div itemprop="image" itemscope itemtype="https://schema.org/ImageObject">
            <meta itemprop="url" content="${escapeHtml(image)}">
            <meta itemprop="width" content="1200">
            <meta itemprop="height" content="675">
          </div>
          <p style="font-size:12px;color:#f44336;font-weight:700;margin:0 0 6px;">
            <a href="https://ajkernews.in/?category=${encodeURIComponent(item.category || 'top')}"
               style="color:#f44336;text-decoration:none;">${escapeHtml(cat)}</a>
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
            • <time datetime="${escapeHtml(publishedDate)}">${escapeHtml(item.published_at || "")}</time>
          </div>
          <a itemprop="url" href="${escapeHtml(link)}"
             style="display:inline-block;margin-top:8px;color:#007bff;font-size:14px;text-decoration:none;">
            পূর্ণ খবর পড়ুন →
          </a>
        </article>`;
    }

    const catNavHtml = categories.map(c => {
      const label = catLabel[c.category] || c.category;
      return `<a href="https://ajkernews.in/?category=${encodeURIComponent(c.category)}"
                 style="display:inline-block;margin:0 6px 6px 0;padding:6px 12px;background:#f5f5f5;border-radius:16px;color:#111;text-decoration:none;font-size:13px;">
        ${escapeHtml(label)} (${c.cnt})
      </a>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>আজকের নিউজ | কলকাতা, পশ্চিমবঙ্গ ও ভারতের সর্বশেষ খবর</title>
<meta name="description" content="কলকাতা, পশ্চিমবঙ্গ, ভারত ও বিশ্বের সর্বশেষ বাংলা খবর। প্রতিদিনের রাজনীতি, খেলা, বিনোদন, ব্যবসা, প্রযুক্তির আপডেট — আজকের নিউজে।">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
<link rel="canonical" href="https://ajkernews.in/">
<meta property="og:type" content="website">
<meta property="og:title" content="আজকের নিউজ | সর্বশেষ বাংলা খবর">
<meta property="og:description" content="কলকাতা, পশ্চিমবঙ্গ, ভারত ও বিশ্বের সর্বশেষ বাংলা খবর।">
<meta property="og:url" content="https://ajkernews.in/">
<meta property="og:image" content="https://ajkernews.in/logo.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"WebSite",
  "name":"আজকের নিউজ",
  "alternateName":["Ajker News","ajkernews.in"],
  "url":"https://ajkernews.in/",
  "inLanguage":"bn-IN",
  "publisher":{"@type":"NewsMediaOrganization","name":"Ajker News","logo":{"@type":"ImageObject","url":"https://ajkernews.in/logo.png"}},
  "potentialAction":{
    "@type":"SearchAction",
    "target":"https://ajkernews.in/?q={search_term_string}",
    "query-input":"required name=search_term_string"
  }
}
</script>
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"CollectionPage",
  "name":"আজকের নিউজ",
  "url":"https://ajkernews.in/",
  "isPartOf":{"@type":"WebSite","url":"https://ajkernews.in/"},
  "inLanguage":"bn-IN"
}
</script>
</head>
<body style="max-width:820px;margin:0 auto;padding:20px;font-family:Inter,-apple-system,sans-serif;color:#111;">
<header>
  <h1 style="font-size:28px;margin:0 0 6px;">
    <a href="/" style="color:#111;text-decoration:none;">আজকের নিউজ</a>
  </h1>
  <p style="color:#666;font-size:15px;margin:0 0 16px;">কলকাতা, পশ্চিমবঙ্গ, ভারত ও বিশ্বের সর্বশেষ খবর</p>
  <nav style="margin-bottom:24px;">${catNavHtml}</nav>
</header>
<main>${newsHtml}</main>
<footer style="margin-top:40px;padding-top:20px;border-top:1px solid #eee;text-align:center;color:#888;font-size:13px;">
  <p>&copy; ${new Date().getFullYear()} Ajker News — All rights reserved.</p>
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
    console.error("Bot homepage error:", error?.message || String(error));
    return new Response("Error loading content", { status: 500 });
  }
}

/* =========================================================
 * BOT ARTICLE PAGE
 * ========================================================= */
async function serveBotArticlePage(id, env) {
  const safeId = String(id || "").trim();
  if (!safeId) return Response.redirect("https://ajkernews.in/", 302);

  const result = await env.DB.prepare(
    `SELECT headline, summary, main_topic, image_url, published_at,
            source_name, source_url, category
     FROM news
     WHERE id = ? AND status = 'published'
     LIMIT 1`
  ).bind(safeId).first();

  if (!result) return Response.redirect("https://ajkernews.in/", 302);

  const title = cleanText(result.headline) || "Ajker News";
  const description = cleanText(result.summary || "").slice(0, 160);
  const fullSummary = cleanText(result.summary || result.main_topic || "");
  const image = result.image_url || "https://ajkernews.in/logo.png";
  const publishedAt = result.published_at || new Date().toISOString();
  const canonical = `https://ajkernews.in/?id=${encodeURIComponent(safeId)}`;

  const newsArticleLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "mainEntityOfPage": { "@type": "WebPage", "@id": canonical },
    "headline": title,
    "description": description,
    "image": [image],
    "datePublished": publishedAt,
    "dateModified": publishedAt,
    "author": {
      "@type": "Organization",
      "name": result.source_name || "Ajker News"
    },
    "publisher": {
      "@type": "Organization",
      "name": "Ajker News",
      "logo": { "@type": "ImageObject", "url": "https://ajkernews.in/logo.png" }
    },
    "inLanguage": "bn-IN",
    "isAccessibleForFree": true
  });

  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "হোম", "item": "https://ajkernews.in/" },
      { "@type": "ListItem", "position": 2, "name": title, "item": canonical }
    ]
  });

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
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<script type="application/ld+json">${newsArticleLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
</head>
<body style="max-width:780px;margin:0 auto;padding:20px;font-family:Inter,-apple-system,sans-serif;color:#111;line-height:1.7;">
<header style="margin-bottom:20px;">
  <p style="margin:0 0 12px;">
    <a href="https://ajkernews.in/" style="color:#007bff;text-decoration:none;font-size:14px;">← আজকের নিউজ হোম</a>
  </p>
</header>
<article itemscope itemtype="https://schema.org/NewsArticle">
  <meta itemprop="datePublished" content="${escapeHtml(publishedAt)}">
  <meta itemprop="dateModified" content="${escapeHtml(publishedAt)}">
  <meta itemprop="mainEntityOfPage" content="${escapeHtml(canonical)}">
  <h1 itemprop="headline" style="font-size:28px;line-height:1.35;margin:0 0 12px;color:#111;">${escapeHtml(title)}</h1>
  <div style="font-size:13px;color:#888;margin-bottom:16px;">
    <span itemprop="author" itemscope itemtype="https://schema.org/Organization">
      <span itemprop="name">${escapeHtml(result.source_name || "Ajker News")}</span>
    </span>
    • <time datetime="${escapeHtml(publishedAt)}">${escapeHtml(publishedAt)}</time>
  </div>
  <div itemprop="image" itemscope itemtype="https://schema.org/ImageObject" style="margin-bottom:18px;">
    <img itemprop="url" src="${escapeHtml(image)}" alt="${escapeHtml(title)}"
         style="width:100%;height:auto;border-radius:8px;display:block;"
         width="1200" height="675">
  </div>
  <div itemprop="articleBody" style="font-size:16px;color:#222;">
    <p>${escapeHtml(fullSummary)}</p>
  </div>
  ${result.source_url ? `
  <p style="margin-top:20px;">
    <a href="${escapeHtml(result.source_url)}" rel="noopener noreferrer nofollow"
       style="color:#007bff;text-decoration:none;font-size:14px;">মূল উৎস দেখুন →</a>
  </p>` : ""}
</article>
<footer style="margin-top:40px;padding-top:20px;border-top:1px solid #eee;text-align:center;color:#888;font-size:13px;">
  <p>&copy; ${new Date().getFullYear()} Ajker News</p>
  <p>
    <a href="https://ajkernews.in/sitemap.xml" style="color:#007bff;">Sitemap</a> ·
    <a href="https://ajkernews.in/news-sitemap.xml" style="color:#007bff;">News Sitemap</a>
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
}

/* =========================================================
 * TABLES SETUP
 * ========================================================= */

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

/* =========================================================
 * SHARE PAGE / NEWS PAGE
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

  const result = await env.DB.prepare(`SELECT headline, summary FROM news WHERE id = ? AND status = 'published' LIMIT 1`).bind(safeId).first();
  if (!result) return Response.redirect("https://ajkernews.in/", 302);

  const openModalParam = (requestUrl && requestUrl.searchParams.get("openModal") === "true") ? "&openModal=true" : "";
  const homeUrl = `https://ajkernews.in/?id=${encodeURIComponent(safeId)}${openModalParam}`;

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

async function serveNewsPage(url, env, request) {
  const id = url.searchParams.get("id");
  if (!id) return Response.redirect("https://ajkernews.in/", 302);

  const ua = (request?.headers?.get("User-Agent") || "");
  const isBot = BOT_REGEX.test(ua);

  if (isBot) {
    return await serveBotArticlePage(id, env);
  }

  return Response.redirect(`https://ajkernews.in/?id=${encodeURIComponent(id)}`, 301);
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

  const requestedLimit = parseInt(url.searchParams.get("limit") || "10", 10);
  const limit = Math.min(Math.max(requestedLimit, 1), 20);
  const queryLimit = limit + 1;

  const selectFields = `news.id, news.headline, news.summary, news.main_topic, news.category, news.image_url, news.published_at, news.source_name, news.source_url, news.created_at, news.score, COUNT(nl.id) AS love_count`;

  if (specificId) {
    const result = await env.DB.prepare(`
      SELECT ${selectFields}
      FROM news
      LEFT JOIN news_loves nl ON nl.news_id = news.id
      WHERE news.id = ? AND news.status = 'published'
      GROUP BY news.id
      LIMIT 1
    `).bind(specificId).all();
    const news = result.results || [];
    return json({ success: true, count: news.length, news }, 200, 300);
  }

  let result;
  if (query) {
    const transliterated = toTransliterated(query);
    result = await env.DB.prepare(`
      SELECT ${selectFields}
      FROM news
      LEFT JOIN news_loves nl ON nl.news_id = news.id
      WHERE news.status = 'published'
        AND (news.search_text LIKE ? OR news.headline LIKE ? OR news.summary LIKE ? OR news.main_topic LIKE ?)
      GROUP BY news.id
      ORDER BY news.published_at DESC
      LIMIT ? OFFSET ?
    `).bind(`%${transliterated}%`, `%${query}%`, `%${query}%`, `%${query}%`, queryLimit, offset).all();
  } else if (category === "trending") {
    result = await env.DB.prepare(`
      SELECT ${selectFields}
      FROM news
      LEFT JOIN news_loves nl ON nl.news_id = news.id
      WHERE news.status = 'published'
      GROUP BY news.id
      ORDER BY news.score DESC, news.published_at DESC
      LIMIT ? OFFSET ?
    `).bind(queryLimit, offset).all();
  } else if (category !== "top" && category !== "all") {
    result = await env.DB.prepare(`
      SELECT ${selectFields}
      FROM news
      LEFT JOIN news_loves nl ON nl.news_id = news.id
      WHERE news.status = 'published' AND news.category = ?
      GROUP BY news.id
      ORDER BY news.published_at DESC
      LIMIT ? OFFSET ?
    `).bind(category, queryLimit, offset).all();
  } else {
    result = await env.DB.prepare(`
      SELECT ${selectFields}
      FROM news
      LEFT JOIN news_loves nl ON nl.news_id = news.id
      WHERE news.status = 'published'
      GROUP BY news.id
      ORDER BY news.published_at DESC
      LIMIT ? OFFSET ?
    `).bind(queryLimit, offset).all();
  }

  const rawNews = result?.results || [];
  const hasMore = rawNews.length > limit;
  const news = rawNews.slice(0, limit);

  return json({ success: true, count: news.length, offset, limit, has_more: hasMore, news }, 200, 30);
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
    const targetUrl = `https://ajkernews.in/?id=${encodeURIComponent(news.id)}`;

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
 * GOOGLE INDEXING API
 * ========================================================= */

async function requestGoogleIndexing(url, env) {
  try {
    const token = await getGoogleAccessToken(env);
    if (!token) {
      console.warn("[INDEXING] Failed to get access token");
      return false;
    }

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
 * SITEMAP + NEWS SITEMAP + RSS
 * ========================================================= */

async function generateSitemap(env) {
  const result = await env.DB.prepare(`SELECT id, created_at FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT ?`).bind(MAX_NEWS).all();
  const news = result.results || [];
  const baseUrl = "https://ajkernews.in";

  let xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`;

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

async function generateNewsSitemap(env) {
  const result = await env.DB.prepare(
    `SELECT id, headline, published_at FROM news
     WHERE status='published'
       AND published_at >= datetime('now','-2 days')
     ORDER BY published_at DESC LIMIT 1000`
  ).all();
  const news = result.results || [];
  const base = "https://ajkernews.in";

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">`;

  for (const n of news) {
    xml += `<url>
  <loc>${base}/?id=${encodeURIComponent(n.id)}</loc>
  <news:news>
    <news:publication>
      <news:name>Ajker News</news:name>
      <news:language>bn</news:language>
    </news:publication>
    <news:publication_date>${escapeHtml(n.published_at)}</news:publication_date>
    <news:title>${escapeHtml(n.headline)}</news:title>
  </news:news>
</url>`;
  }
  xml += `</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=UTF-8",
      "Cache-Control": "public, max-age=600, s-maxage=1800"
    }
  });
}

async function generateRSS(env) {
  const result = await env.DB.prepare(
    `SELECT id, headline, summary, published_at, image_url, source_name
     FROM news WHERE status='published'
     ORDER BY published_at DESC LIMIT 50`
  ).all();
  const news = result.results || [];
  const base = "https://ajkernews.in";

  const items = news.map(n => {
    const link = `${base}/?id=${encodeURIComponent(n.id)}`;
    const pubDate = n.published_at ? new Date(n.published_at).toUTCString() : new Date().toUTCString();
    return `<item>
  <title>${escapeHtml(n.headline)}</title>
  <link>${link}</link>
  <guid isPermaLink="true">${link}</guid>
  <pubDate>${pubDate}</pubDate>
  <description><![CDATA[${n.summary || ""}]]></description>
  ${n.image_url ? `<enclosure url="${escapeHtml(n.image_url)}" type="image/jpeg"/>` : ""}
</item>`;
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>আজকের নিউজ</title>
  <link>${base}/</link>
  <description>কলকাতা, পশ্চিমবঙ্গ, ভারত ও বিশ্বের সর্বশেষ বাংলা খবর</description>
  <language>bn-IN</language>
  <atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml"/>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=UTF-8",
      "Cache-Control": "public, max-age=600, s-maxage=1800"
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
