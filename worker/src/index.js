/**
 * Ajker News Worker - Complete Backend with Auto-Indexing
 * D1 Database: ajkernews-db
 */

import webPush from 'web-push';
import ANALYTICS_CONFIG from './config-analytics.js';
import ADS_CONFIG from './config-ads.js';
import AFFILIATE_CONFIG from './config-affiliate.js';

const MAX_NEWS = 200;
const MAX_SELECTED_NEWS = 5;
const GNEWS_MAX_RESULTS = 10;
const GEMINI_MODEL = "gemini-3.6-flash";

// বাংলা → ইংরেজি ট্রান্সলিটারেশন
const BN_TO_EN_MAP = {
    'অ':'o','আ':'a','ই':'i','ঈ':'i','উ':'u','ঊ':'u','ঋ':'ri','এ':'e','ঐ':'oi','ও':'o','ঔ':'ou',
    'ক':'k','খ':'kh','গ':'g','ঘ':'gh','ঙ':'ng','চ':'ch','ছ':'chh','জ':'j','ঝ':'jh','ঞ':'n',
    'ট':'t','ঠ':'th','ড':'d','ঢ':'dh','ণ':'n','ত':'t','থ':'th','দ':'d','ধ':'dh','ন':'n',
    'প':'p','ফ':'ph','ব':'b','ভ':'bh','ম':'m','য':'j','র':'r','ল':'l','শ':'sh','ষ':'sh',
    'স':'s','হ':'h','ড়':'r','ঢ়':'rh','য়':'y','ং':'ng','ঃ':'h','ঁ':'n','ক্ষ':'khy','জ্ঞ':'gg',
    'া':'a','ি':'i','ী':'i','ু':'u','ূ':'u','ৃ':'ri','ে':'e','ৈ':'oi','ো':'o','ৌ':'ou'
};

function toTransliterated(text) {
    if (!text) return '';
    let result = '';
    for (const char of text) {
        result += BN_TO_EN_MAP[char] || char;
    }
    return result.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ==================== ENSURE TABLES ====================
async function ensureTables(env) {
  const queries = [
    `CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY,
      source_url TEXT UNIQUE,
      source_name TEXT,
      source_title TEXT,
      source_description TEXT,
      headline TEXT,
      summary TEXT,
      main_topic TEXT,
      category TEXT,
      image_url TEXT,
      published_at TEXT,
      created_at TEXT,
      day_key TEXT,
      status TEXT DEFAULT 'published',
      score INTEGER DEFAULT 0,
      search_text TEXT,
      indexed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS news_loves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id TEXT,
      device_id TEXT,
      UNIQUE(news_id, device_id)
    )`,
    `CREATE TABLE IF NOT EXISTS news_comments (
      id TEXT PRIMARY KEY,
      news_id TEXT,
      author_name TEXT,
      comment_text TEXT,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT UNIQUE,
      keys_json TEXT,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS affiliate_clicks (
      id TEXT PRIMARY KEY,
      affiliate_name TEXT,
      click_url TEXT,
      device_id TEXT,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS indexing_log (
      id TEXT PRIMARY KEY,
      news_id TEXT,
      url TEXT,
      status TEXT,
      response TEXT,
      created_at TEXT
    )`
  ];
  for (const sql of queries) {
    await env.DB.prepare(sql).run();
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      await ensureTables(env);

      // ===== Search Console Verification =====
      if (url.pathname === ANALYTICS_CONFIG.searchConsole.filePath) {
        return new Response(ANALYTICS_CONFIG.searchConsole.content, {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8" }
        });
      }

      // ===== ads.txt =====
      if (url.pathname === "/ads.txt") {
        return new Response(ADS_CONFIG.adsTxtContent, {
          status: 200,
          headers: { "content-type": "text/plain; charset=UTF-8" }
        });
      }

      // ===== Short URL Redirect (NO OG TAGS) =====
      if (url.pathname.startsWith("/go/")) {
        const id = url.pathname.split("/")[2];
        if (id) {
          return Response.redirect(`/?id=${id}`, 302);
        }
        return new Response("Invalid link", { status: 400 });
      }

      // ===== Affiliate API =====
      if (url.pathname === "/api/affiliate" && request.method === "GET") {
        const ref = url.searchParams.get("ref") || "direct";
        let targetUrl = url.searchParams.get("url");
        
        if (!targetUrl && AFFILIATE_CONFIG.redirectMap[ref]) {
          targetUrl = AFFILIATE_CONFIG.redirectMap[ref];
        }
        if (!targetUrl) {
          targetUrl = AFFILIATE_CONFIG.defaultRedirect;
        }

        if (AFFILIATE_CONFIG.trackClicks) {
          try {
            const deviceId = request.headers.get("CF-Connecting-IP") || "unknown";
            await env.DB.prepare(
              `INSERT INTO affiliate_clicks (id, affiliate_name, click_url, device_id, created_at) 
               VALUES (?, ?, ?, ?, ?)`
            ).bind(crypto.randomUUID(), ref, targetUrl, deviceId, new Date().toISOString()).run();
          } catch (e) {
            console.error("Affiliate log error:", e);
          }
        }

        return Response.redirect(targetUrl, 302);
      }

      if (url.pathname === "/news" && url.searchParams.has("id")) {
        return await serveNewsPage(url, env);
      }

      if (url.pathname === "/sitemap.xml") return await generateSitemap(env);

      if (url.pathname === "/api/news") return await handleGetNews(url, env);
      
      if (url.pathname === "/api/update") {
        if (request.method !== "POST") return json({ success: false, error: "POST method required" }, 405);
        const result = await updateNews(env);
        return json({ success: true, ...result });
      }
      
      if (url.pathname === "/api/love") {
        if (request.method !== "POST") return json({ error: "POST required" }, 405);
        return await toggleLove(request, env);
      }
      
      if (url.pathname === "/api/comments") {
        if (request.method === "GET") return await getComments(url, env);
        if (request.method === "POST") return await addComment(request, env);
        return json({ error: "Method not allowed" }, 405);
      }
      
      if (url.pathname === "/api/subscribe" && request.method === "POST") {
        return await handleSubscribe(request, env);
      }

      return new Response("Ajker News Worker is running.", { 
        status: 200, 
        headers: { "content-type": "text/plain; charset=UTF-8" } 
      });

    } catch (error) {
      console.error("Worker error:", error);
      return json({ success: false, error: error?.message || "Internal server error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    console.log(`⏰ [${new Date().toISOString()}] Scheduled update triggered (1-hour interval)`);
    
    try {
        const result = await updateNews(env);
        console.log(`✅ Update completed:`, result);
        
        if (result.stored > 0) {
            await sendPushNotifications(
                env, 
                '📰 নতুন খবর!', 
                `${result.stored}টি নতুন খবর প্রকাশিত হয়েছে।`, 
                'https://ajkernews.in/'
            );
        }
    } catch (error) {
        console.error(`❌ [${new Date().toISOString()}] Scheduled update failed:`, error);
    }
  }
};

// ==================== SERVE DYNAMIC OG PAGE (og:site_name বাদ) ====================
async function serveNewsPage(url, env) {
  const id = url.searchParams.get("id");
  const result = await env.DB.prepare(
    `SELECT headline, summary, image_url, published_at, source_name FROM news WHERE id = ? AND status = 'published'`
  ).bind(id).first();

  if (!result) {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }

  const title = result.headline || "Ajker News";
  const description = (result.summary || "").slice(0, 160);
  const image = result.image_url || null; 
  const siteUrl = "https://ajkernews.in";

  let metaImageTags = '';
  if (image) {
    metaImageTags = `
      <meta property="og:image" content="${escapeHtml(image)}">
      <meta name="twitter:image" content="${escapeHtml(image)}">`;
  }

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)} - Ajker News</title>
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${siteUrl}/?id=${id}">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  ${metaImageTags}
  <meta http-equiv="refresh" content="0;url=${siteUrl}/?id=${id}">
  <style>body{font-family:sans-serif;padding:20px;text-align:center}</style>
</head>
<body>
  <p>Redirecting to <a href="${siteUrl}/?id=${id}">${escapeHtml(title)}</a>...</p>
</body>
</html>`;

  const analyticsScript = `
  <script async src="https://www.googletagmanager.com/gtag/js?id=${ANALYTICS_CONFIG.gaTrackingId}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${ANALYTICS_CONFIG.gaTrackingId}');
  </script>
  ${ANALYTICS_CONFIG.extraHeadScripts}
  ${ADS_CONFIG.adNetworkScripts}
  `;

  html = html.replace('</head>', analyticsScript + '</head>');

  if (ADS_CONFIG.extraFooterScripts) {
    html = html.replace('</body>', ADS_CONFIG.extraFooterScripts + '</body>');
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=3600",
      ...corsHeaders()
    }
  });
}

// ==================== AUTO-INDEXING: GOOGLE INDEXING API ====================
async function requestGoogleIndexing(url, env) {
  try {
    const token = await getGoogleAccessToken(env);
    if (!token) {
      console.error('Failed to get Google access token');
      return false;
    }

    const response = await fetch(
      'https://indexing.googleapis.com/v3/urlNotifications:publish',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: url,
          type: 'URL_UPDATED'
        })
      }
    );

    const responseText = await response.text();
    const logId = crypto.randomUUID();
    
    await env.DB.prepare(
      `INSERT INTO indexing_log (id, news_id, url, status, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      logId,
      url.split('id=')[1] || 'unknown',
      url,
      response.ok ? 'success' : 'failed',
      responseText,
      new Date().toISOString()
    ).run();

    if (!response.ok) {
      console.error(`Google Indexing API error (${response.status}): ${responseText}`);
      return false;
    }

    console.log(`✅ Indexing requested for: ${url}`);
    return true;
  } catch (error) {
    console.error('Indexing API error:', error);
    return false;
  }
}

// ==================== GOOGLE ACCESS TOKEN (Auto-Refresh) ====================
async function getGoogleAccessToken(env) {
  try {
    const serviceAccountJson = env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
      console.error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
      return null;
    }

    const credentials = JSON.parse(serviceAccountJson);
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 3600;

    const header = { alg: 'RS256', typ: 'JWT' };
    const claimSet = {
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/indexing',
      aud: 'https://oauth2.googleapis.com/token',
      exp: expiry,
      iat: now
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
    const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(credentials.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(signatureInput)
    );

    const encodedSignature = base64UrlEncode(
      String.fromCharCode(...new Uint8Array(signature))
    );

    const jwt = `${encodedHeader}.${encodedClaimSet}.${encodedSignature}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Token exchange failed:', errorText);
      return null;
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error('Token generation error:', error);
    return null;
  }
}

function base64UrlEncode(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const lines = pem.split('\n');
  let base64 = '';
  for (const line of lines) {
    if (!line.includes('-----')) {
      base64 += line;
    }
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ==================== PING SEARCH ENGINES ====================
async function pingSearchEngines() {
  const sitemapUrl = encodeURIComponent('https://ajkernews.in/news-sitemap.xml');
  try {
    await fetch(`https://www.google.com/ping?sitemap=${sitemapUrl}`, { method: 'GET' });
    console.log('✅ Google pinged');
  } catch (e) { /* ignore */ }
  try {
    await fetch(`https://www.bing.com/ping?sitemap=${sitemapUrl}`, { method: 'GET' });
    console.log('✅ Bing pinged');
  } catch (e) { /* ignore */ }
}

// ==================== LOVE (Toggle) ====================
async function toggleLove(request, env) {
  try {
    const { id, deviceId } = await request.json();
    if (!id || !deviceId) return json({ error: "Missing id or deviceId" }, 400);

    const existing = await env.DB.prepare(
      `SELECT id FROM news_loves WHERE news_id = ? AND device_id = ?`
    ).bind(id, deviceId).first();

    if (existing) {
      await env.DB.prepare(`DELETE FROM news_loves WHERE news_id = ? AND device_id = ?`).bind(id, deviceId).run();
    } else {
      await env.DB.prepare(`INSERT INTO news_loves (news_id, device_id) VALUES (?, ?)`).bind(id, deviceId).run();
    }

    const countResult = await env.DB.prepare(`SELECT COUNT(*) as count FROM news_loves WHERE news_id = ?`).bind(id).first();
    return json({ success: true, love_count: Number(countResult?.count || 0) });
  } catch (error) {
    console.error("Love error:", error);
    return json({ success: false, error: error.message }, 500);
  }
}

// ==================== COMMENTS ====================
async function getComments(url, env) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: "Missing id" }, 400);
  const result = await env.DB.prepare(
    `SELECT id, author_name, comment_text, created_at FROM news_comments WHERE news_id = ? ORDER BY created_at ASC`
  ).bind(id).all();
  return json({ comments: result.results || [] });
}

async function addComment(request, env) {
  const { newsId, author, text } = await request.json();
  if (!newsId || !text) return json({ error: "Missing fields" }, 400);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO news_comments (id, news_id, author_name, comment_text, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, newsId, author || 'Guest', text, createdAt).run();
  return json({ success: true, comment_id: id });
}

// ==================== PUSH SUBSCRIPTION ====================
async function handleSubscribe(request, env) {
  try {
    const subscription = await request.json();
    const endpoint = subscription.endpoint;
    const keys = JSON.stringify(subscription.keys);

    const existing = await env.DB.prepare(
      `SELECT id FROM push_subscriptions WHERE endpoint = ?`
    ).bind(endpoint).first();

    if (existing) {
      return json({ success: true, message: "Already subscribed" });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, keys_json, created_at) VALUES (?, ?, ?, ?)`
    ).bind(id, endpoint, keys, createdAt).run();

    return json({ success: true });
  } catch (error) {
    console.error("Subscribe error:", error);
    return json({ success: false, error: error.message }, 500);
  }
}

// ==================== UPDATE NEWS (WITH AUTO-INDEXING) ====================
async function updateNews(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  if (!env.GNEWS_API_KEY) throw new Error("GNEWS_API_KEY secret is missing");
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY secret is missing");

  const candidates = await fetchGNews(env);
  if (!candidates.length) return { fetched: 0, unique: 0, selected: 0, stored: 0, deleted: 0, message: "No news found" };

  const uniqueCandidates = await removeExistingNews(candidates, env);
  if (!uniqueCandidates.length) return { fetched: candidates.length, unique: 0, selected: 0, stored: 0, deleted: 0, message: "No new news available" };

  const selected = await processWithGemini(uniqueCandidates, env);
  const finalNews = selected.slice(0, MAX_SELECTED_NEWS);

  let stored = 0;
  const indexedUrls = [];
  
  for (const news of finalNews) {
    try { 
      await insertNews(news, env); 
      stored++;
      const newsUrl = `https://ajkernews.in/?id=${news.id}`;
      indexedUrls.push(newsUrl);
    } catch (error) { 
      console.error("News insert failed:", error); 
    }
  }

  const deleted = await enforceMaximumNews(env);

  // ===== AUTO-INDEXING =====
  if (stored > 0 && env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log(`🚀 Auto-indexing ${stored} news articles...`);
    for (const url of indexedUrls) {
      let success = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        success = await requestGoogleIndexing(url, env);
        if (success) break;
        console.log(`Retry ${attempt} for ${url}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (!success) {
        console.error(`❌ Failed to index: ${url}`);
      }
    }
    await pingSearchEngines();
    console.log('✅ Search engines pinged');
  }

  if (stored > 0) {
    try {
      await sendPushNotifications(env, '📰 নতুন খবর!', `${stored}টি নতুন খবর প্রকাশিত হয়েছে।`, 'https://ajkernews.in/');
    } catch (err) {
      console.error("Push notification error:", err);
    }
  }

  return { 
    fetched: candidates.length, 
    unique: uniqueCandidates.length, 
    selected: finalNews.length, 
    stored, 
    deleted, 
    indexed: stored > 0 ? indexedUrls.length : 0,
    message: `News update completed. ${stored} stored, ${indexedUrls.length} indexed.` 
  };
}

// ==================== GNews ====================
async function fetchGNews(env) {
  const url = new URL("https://gnews.io/api/v4/top-headlines");
  url.searchParams.set("lang", "en");
  url.searchParams.set("country", "in");
  url.searchParams.set("max", String(GNEWS_MAX_RESULTS));
  url.searchParams.set("apikey", env.GNEWS_API_KEY);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "accept": "application/json" }
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GNews API ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.articles)) return [];

  return data.articles.slice(0, GNEWS_MAX_RESULTS).map(article => ({
    source_name: article.source?.name || "",
    source_url: normalizeUrl(article.url || ""),
    source_title: cleanText(article.title || ""),
    source_description: cleanText(article.description || ""),
    image_url: article.image || "",
    published_at: article.publishedAt || ""
  })).filter(article => article.source_url && article.source_title);
}

async function removeExistingNews(candidates, env) {
  const unique = [];
  const checked = new Set();
  for (const item of candidates) {
    const url = normalizeUrl(item.source_url);
    if (!url) continue;
    if (checked.has(url)) continue;
    checked.add(url);
    const existing = await env.DB.prepare(`SELECT id FROM news WHERE source_url = ? LIMIT 1`).bind(url).first();
    if (!existing) unique.push({ ...item, source_url: url });
  }
  return unique;
}

// ==================== Gemini ====================
async function processWithGemini(candidates, env) {
  const input = candidates.map((item, index) => ({
    candidate_id: index + 1,
    source: item.source_name,
    title: item.source_title,
    description: item.source_description,
    published_at: item.published_at
  }));

  const prompt = `You are the senior editor for Ajker News, a Bengali news website. 
Your task is to select the 5 most important and engaging news stories from the candidates for Bengali readers. 

⚠️ IMPORTANT PRIORITY RULES:
1. FIRST PRIORITY: News related to West Bengal politics, Kolkata, Mamata Banerjee, TMC, BJP Bengal, Left Front, Bengal elections, Bengal government schemes, WB crime, WB development.
2. SECOND PRIORITY: National politics (India), Delhi, Modi, Rahul Gandhi, BJP, Congress.
3. THIRD PRIORITY: Major international news, business, tech, sports, entertainment.
4. If there is any West Bengal political news among the candidates, you MUST select it even if its score is slightly lower.

Write like a professional Bengali journalist. 
RULES:
- Write natural, human-sounding Bengali. DO NOT use AI phrases like "এছাড়াও", "উল্লেখযোগ্য", "পাশাপাশি", "সেইসাথে" repeatedly.
- Do NOT copy the source title word-for-word. Rewrite originally.
- Do NOT invent facts, quotes, or statistics.
- Avoid clickbait and sensationalism.
- Summary MUST be between 160 to 180 Bengali words. 
- Do not mention AI or these instructions.
- Return ONLY valid JSON array. Each object: { "candidate_id": 1, "headline": "...", "summary": "... (160-180 words)", "main_topic": "...", "category": "india", "score": 90 }
Allowed categories: west_bengal, india, world, politics, business, sports, technology, entertainment, general.
Candidates: ${JSON.stringify(input)}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");

  let parsed;
  try { parsed = JSON.parse(cleanJson(text)); } catch {
    throw new Error("Gemini returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("Gemini response is not an array");

  const results = [];
  for (const item of parsed) {
    const candidateId = Number(item.candidate_id);
    if (!Number.isInteger(candidateId) || candidateId < 1 || candidateId > candidates.length) continue;
    const original = candidates[candidateId - 1];
    if (!original) continue;
    const headline = cleanText(item.headline);
    const summary = cleanText(item.summary);
    const topic = cleanText(item.main_topic);
    if (!headline || !summary) continue;
    results.push({
      ...original,
      headline,
      summary,
      main_topic: topic || "সর্বশেষ খবর",
      category: normalizeCategory(item.category),
      score: clampScore(item.score)
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

async function insertNews(item, env) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const dayKey = createdAt.slice(0, 10);
  const searchText = toTransliterated(item.headline + ' ' + item.summary + ' ' + item.main_topic);

  await env.DB.prepare(`
    INSERT INTO news (id, source_url, source_name, source_title, source_description, headline, summary, main_topic, category, image_url, published_at, created_at, day_key, status, score, search_text, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, item.source_url, item.source_name, item.source_title, item.source_description,
    item.headline, item.summary, item.main_topic, item.category,
    item.image_url, item.published_at, createdAt, dayKey, "published", item.score, searchText, null
  ).run();
  
  item.id = id;
}

// ==================== GET NEWS API (OPTIMIZED: 25 + OFFSET) ====================
async function handleGetNews(url, env) {
  const category = url.searchParams.get("category") || "top";
  const query = (url.searchParams.get("q") || "").trim();
  const specificId = url.searchParams.get("id");
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const limit = 25;
  
  let result;

  const selectFields = `
    id, headline, summary, main_topic, category, image_url, published_at, source_name, source_url, created_at, score,
    COALESCE(lc.love_count, 0) as love_count
  `;

  if (specificId) {
    result = await env.DB.prepare(
      `SELECT ${selectFields} FROM news 
       LEFT JOIN (SELECT news_id, COUNT(*) as love_count FROM news_loves GROUP BY news_id) lc ON news.id = lc.news_id
       WHERE news.id = ? AND news.status = 'published'`
    ).bind(specificId).all();
    if (!result.results || result.results.length === 0) {
      return json({ success: true, count: 0, news: [] });
    }
    return json({ success: true, count: 1, news: result.results });
  }

  let searchPattern = null;
  if (query) {
    const transliterated = toTransliterated(query);
    searchPattern = `%${transliterated}%`;
  }

  if (searchPattern) {
    result = await env.DB.prepare(
      `SELECT ${selectFields} FROM news 
       LEFT JOIN (SELECT news_id, COUNT(*) as love_count FROM news_loves GROUP BY news_id) lc ON news.id = lc.news_id
       WHERE news.status = 'published' AND (news.search_text LIKE ? OR news.headline LIKE ? OR news.summary LIKE ? OR news.main_topic LIKE ?) 
       ORDER BY news.published_at DESC LIMIT ? OFFSET ?`
    ).bind(searchPattern, `%${query}%`, `%${query}%`, `%${query}%`, limit, offset).all();
  } else if (category === "trending") {
    result = await env.DB.prepare(
      `SELECT ${selectFields} FROM news 
       LEFT JOIN (SELECT news_id, COUNT(*) as love_count FROM news_loves GROUP BY news_id) lc ON news.id = lc.news_id
       WHERE news.status = 'published' 
       ORDER BY news.score DESC, news.published_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
  } else if (category !== "top" && category !== "all") {
    result = await env.DB.prepare(
      `SELECT ${selectFields} FROM news 
       LEFT JOIN (SELECT news_id, COUNT(*) as love_count FROM news_loves GROUP BY news_id) lc ON news.id = lc.news_id
       WHERE news.status = 'published' AND news.category = ? 
       ORDER BY news.published_at DESC LIMIT ? OFFSET ?`
    ).bind(category, limit, offset).all();
  } else {
    result = await env.DB.prepare(
      `SELECT ${selectFields} FROM news 
       LEFT JOIN (SELECT news_id, COUNT(*) as love_count FROM news_loves GROUP BY news_id) lc ON news.id = lc.news_id
       WHERE news.status = 'published' 
       ORDER BY news.published_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
  }

  const news = result?.results || [];
  return json({ success: true, count: news.length, offset: offset, limit: limit, news });
}

// ==================== ENFORCE MAX NEWS ====================
async function enforceMaximumNews(env) {
  const result = await env.DB.prepare(`SELECT COUNT(*) AS total FROM news`).first();
  const total = Number(result?.total || 0);
  if (total <= MAX_NEWS) return 0;

  const deleteCount = total - MAX_NEWS;
  const toDelete = await env.DB.prepare(`SELECT id FROM news ORDER BY created_at ASC LIMIT ?`).bind(deleteCount).all();
  const idsToDelete = toDelete.results.map(row => row.id);

  for (const id of idsToDelete) {
    await env.DB.prepare(`DELETE FROM news_loves WHERE news_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM news_comments WHERE news_id = ?`).bind(id).run();
  }

  const placeholders = idsToDelete.map(() => '?').join(',');
  if (placeholders) {
    await env.DB.prepare(`DELETE FROM news WHERE id IN (${placeholders})`).bind(...idsToDelete).run();
  }

  return deleteCount;
}

// ==================== PUSH NOTIFICATIONS ====================
async function sendPushNotifications(env, title, body, url) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('VAPID keys not set. Push notification skipped.');
    return;
  }

  const subscriptions = await env.DB.prepare(`SELECT endpoint, keys_json FROM push_subscriptions`).all();
  if (!subscriptions.results || subscriptions.results.length === 0) return;

  webPush.setVapidDetails(
    'mailto:info.ajkernews@gmail.com',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  const payload = JSON.stringify({ title, body, url, icon: '/assets/logo.png' });

  for (const sub of subscriptions.results) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: JSON.parse(sub.keys_json)
        },
        payload
      );
    } catch (error) {
      console.error('Push send error:', error);
      if (error.statusCode === 410 || error.statusCode === 404) {
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(sub.endpoint).run();
      }
    }
  }
}

// ==================== SITEMAP ====================
async function generateSitemap(env) {
    const result = await env.DB.prepare(
        `SELECT id, created_at FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT 200`
    ).all();
    const news = result.results || [];
    const baseUrl = 'https://ajkernews.in';
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    xml += `<url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`;
    for (const item of news) {
        const lastmod = item.created_at ? item.created_at.split('T')[0] : new Date().toISOString().split('T')[0];
        xml += `<url><loc>${baseUrl}/?id=${item.id}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`;
    }
    xml += `</urlset>`;
    return new Response(xml, {
        status: 200,
        headers: {
            'Content-Type': 'application/xml',
            'Cache-Control': 'public, max-age=3600',
            ...corsHeaders()
        }
    });
}

// ==================== UTILITIES ====================
function normalizeUrl(url) {
  try { const parsed = new URL(url); parsed.hash = ""; return parsed.toString(); } catch { return String(url).trim(); }
}
function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
function cleanJson(text) {
  let value = String(text || "").trim();
  if (value.startsWith("```")) {
    value = value.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  }
  return value;
}
function normalizeCategory(category) {
  const allowed = new Set(["west_bengal", "india", "world", "politics", "business", "sports", "technology", "entertainment", "general"]);
  const value = String(category || "").trim().toLowerCase();
  return allowed.has(value) ? value : "general";
}
function clampScore(score) {
  const number = Number(score);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400"
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "public, max-age=60"
    }
  });
}
function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
