// worker/src/index.js
// ✅ FINAL v52.0: Popunder 35s | Favicon Redirects | Home→Article Dead Click
// Article + Social Bar + 24h TTL + Image Push + Spam Filter + One Comment Per User

import { FCM, FcmOptions } from "fcm-cloudflare-workers";
import ANALYTICS_CONFIG from "./config-analytics.js";
import ADS_CONFIG from "./config-ads.js";
import { processSelectedNews } from "./gemini.js";
import { runGNewsBatch } from "./news-fetcher.js";
import { selectBestCandidates, publishSelectedNews } from "./news-selector.js";
import { enforceNewsLimit, cleanOldCandidates, cleanRejectedNews } from "./cleanup.js";
import { fastIndexNews } from "./fast-index.js";
import { cacheNewsApi, purgeNewsApiCache, purgeArticleCache } from "./cache.js";
import { getFcmCredentials } from "./jwt.js";
import { cleanText, escapeHtml } from "./utils.js";

const MAX_NEWS = 5000;
const API_PAGE_SIZE = 10;
const API_CACHE_TTL = 300;

const NOTIFICATION_CONFIG = {
  TTL_SECONDS: 86400,           // ✅ 24 hours (was 7 days)
  QUIET_START_HOUR: 23,
  QUIET_END_HOUR: 7,
  BREAKING_SCORE_THRESHOLD: 55,
  BREAKING_TTL_SECONDS: 86400,  // ✅ 24 hours
  REGULAR_TTL_SECONDS: 86400,   // ✅ 24 hours
  MAX_BATCH_SIZE: 500,
  DIGEST_NEWS_COUNT: 3,
  DIGEST_MIN_NEWS: 2,
  MAX_BREAKING_PER_DAY: 2,
  PRIME_HOURS: [8, 13, 18, 21]
};

let tablesReadyPromise = null;

// ═══════════════════════════════════════════════════════════
// ✅ POPUNDER (Merged from article-popunder.js)
// 35 seconds time-based trigger only (NO click blocker)
// Daily once per user | Article page only
// ═══════════════════════════════════════════════════════════
const POPUNDER_URL = "https://afders.org/1/cefd70fdb5260cccd9456ab45e1e7512";

function getArticlePopunderScript() {
  return `<script>
(function() {
  'use strict';

  var POPUNDER_URL = "${POPUNDER_URL}";
  var COOLDOWN_KEY = 'popunder_article_last_fire';
  var COOLDOWN_MS = 24 * 60 * 60 * 1000;      // ✅ 24 hours = daily once
  var TIME_TRIGGER_MS = 35 * 1000;             // ✅ 35 seconds trigger
  var fired = false;
  var scriptLoaded = false;
  var timeTimer = null;
  var pageStartTime = Date.now();
  var hiddenAt = null;

  // ✅ 24h cooldown check
  var last = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10);
  if ((Date.now() - last) < COOLDOWN_MS) {
    console.log('[Popunder] Cooldown active — skip');
    return;
  }

  // ✅ Same article-এ session-এ একবারই
  var pathId = (window.location.pathname || '').split('/').filter(Boolean).pop() || '';
  var FIRED_KEY = 'popunder_fired_' + pathId;
  if (sessionStorage.getItem(FIRED_KEY) === '1') {
    console.log('[Popunder] Already fired in this session');
    return;
  }

  // ✅ Adsterra script load
  function loadPopunderScript() {
    if (scriptLoaded) return;
    if (document.querySelector('script[data-ajker-popunder]')) {
      scriptLoaded = true;
      return;
    }
    console.log('[Popunder] Loading Adsterra script...');
    var s = document.createElement('script');
    s.async = true;
    s.src = POPUNDER_URL;
    s.setAttribute('data-cfasync', 'false');
    s.setAttribute('data-ajker-popunder', '1');
    s.onload = function() {
      scriptLoaded = true;
      console.log('[Popunder] Script loaded ✅');
    };
    s.onerror = function() {
      console.warn('[Popunder] Script load failed ❌');
    };
    document.body.appendChild(s);
  }

  // ✅ Fire popunder — one time only
  function firePopunder(source) {
    if (fired) return;
    fired = true;
    sessionStorage.setItem(FIRED_KEY, '1');
    localStorage.setItem(COOLDOWN_KEY, String(Date.now()));
    console.log('[Popunder] Triggered by:', source);
    loadPopunderScript();
  }

  // ✅ 35 seconds time-based trigger
  timeTimer = setTimeout(function() {
    firePopunder('35 seconds on page');
  }, TIME_TRIGGER_MS);

  // ✅ Tab hidden → timer pause; Tab visible → resume
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      if (timeTimer && !fired) {
        clearTimeout(timeTimer);
        timeTimer = null;
        hiddenAt = Date.now();
        console.log('[Popunder] Timer paused (tab hidden)');
      }
    } else {
      if (!fired && !timeTimer && hiddenAt) {
        var visibleBefore = hiddenAt - pageStartTime;
        var remaining = Math.max(1000, TIME_TRIGGER_MS - visibleBefore);
        console.log('[Popunder] Timer resumed — remaining:', Math.round(remaining / 1000), 's');
        timeTimer = setTimeout(function() {
          firePopunder('35 seconds on page (after resume)');
        }, remaining);
      }
    }
  });

  // ✅ Initial check — user already 35s পার করেছে কিনা
  if (Date.now() - pageStartTime >= TIME_TRIGGER_MS) {
    firePopunder('already past 35 seconds');
  }
})();
<\/script>`;
}

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

function getISTHour() {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return istNow.getUTCHours();
}

function isQuietHours() {
  const hour = getISTHour();
  const { QUIET_START_HOUR, QUIET_END_HOUR } = NOTIFICATION_CONFIG;
  if (QUIET_START_HOUR > QUIET_END_HOUR) {
    return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
  }
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

function isBreakingNews(news) {
  return Number(news.score || 0) >= NOTIFICATION_CONFIG.BREAKING_SCORE_THRESHOLD;
}

function getDigestLabel(hour) {
  if (hour === 8) return "🌅 সকালের সেরা খবর";
  if (hour === 13) return "☀️ দুপুরের আপডেট";
  if (hour === 18) return "🌇 বিকেলের সেরা খবর";
  if (hour === 21) return "🌙 রাতের আপডেট";
  return "📰 আজকের খবর";
}

function getDigestType(hour) {
  if (hour === 8) return "morning";
  if (hour === 13) return "noon";
  if (hour === 18) return "evening";
  if (hour === 21) return "night";
  return "general";
}

function getAdsterraScripts() {
  const scripts = [];
  if (ADS_CONFIG?.socialBarScript && !ADS_CONFIG.socialBarScript.includes("YOUR_SOCIAL_BAR_SCRIPT")) {
    scripts.push(ADS_CONFIG.socialBarScript);
  }
  if (ADS_CONFIG?.nativeBannerScript && !ADS_CONFIG.nativeBannerScript.includes("YOUR_NATIVE_BANNER_SCRIPT")) {
    scripts.push(ADS_CONFIG.nativeBannerScript);
  }
  return scripts.join("\n");
}

function getNativeBannerContainer() {
  const containerId = ADS_CONFIG?.nativeBannerContainerId;
  if (!containerId || containerId === "YOUR_NATIVE_BANNER_CONTAINER_ID") {
    return "";
  }
  return `<div class="native-banner-block" style="margin: 28px 0 8px; padding: 16px; background: #fafafa; border-radius: 14px; border: 1px dashed #e0e0e0; min-height: 260px;">
    <div style="font-size: 11px; color: #999; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Sponsored</div>
    <div id="${containerId}" style="min-height: 250px; width: 100%;"></div>
  </div>`;
}

function getAdultBlockerScript() {
  return `<script src="/adblock.js" defer><\/script>`;
}

function getSocialBarTopScript() {
  return `<style id="socialBarTopStyle">
html body > div[class*="socialbar"],
html body > div[class*="social-bar"],
html body > div[class*="adsterra"],
html body > div[id*="socialbar"],
html body > div[id*="social-bar"],
html body > div[id*="adsterra"],
html body > div[class*="sb-"],
html body > iframe[class*="socialbar"],
html body > iframe[class*="adsterra"],
html body > iframe[id*="socialbar"],
html body > iframe[id*="adsterra"],
html body > div[style*="bottom: 0"],
html body > div[style*="bottom:0"],
html body > div[style*="bottom: 10"],
html body > div[style*="bottom:10"],
html body > div[style*="bottom: 15"],
html body > div[style*="bottom:15"],
html body > div[style*="bottom: 20"],
html body > div[style*="bottom:20"] {
  top: 0 !important;
  bottom: auto !important;
  left: 0 !important;
  right: auto !important;
  position: fixed !important;
  z-index: 99999 !important;
  transform: none !important;
  margin: 0 !important;
}
html body > div[class*="socialbar"] iframe,
html body > div[class*="adsterra"] iframe,
html body > div[id*="socialbar"] iframe,
html body > div[id*="adsterra"] iframe {
  top: 0 !important;
  bottom: auto !important;
  left: 0 !important;
  right: auto !important;
  position: fixed !important;
}
</style>
<script>
(function() {
  'use strict';
  function moveSocialBarToTop() {
    try {
      var all = document.querySelectorAll('body > div, body > iframe, body > ins');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.id === 'artCommentModal') continue;
        
        var cls = (el.className || '').toString().toLowerCase();
        var idn = (el.id || '').toString().toLowerCase();
        var style = window.getComputedStyle(el);
        
        var isSocialBar = (
          cls.indexOf('social') !== -1 ||
          cls.indexOf('adsterra') !== -1 ||
          cls.indexOf('sb-') !== -1 ||
          idn.indexOf('social') !== -1 ||
          idn.indexOf('adsterra') !== -1
        );
        
        var isFixedBottom = (
          style.position === 'fixed' &&
          (style.bottom === '0px' || parseInt(style.bottom, 10) >= -5) &&
          el.offsetHeight > 0 && el.offsetHeight < 250 &&
          style.top !== '0px'
        );
        
        if (isSocialBar || isFixedBottom) {
          el.style.setProperty('top', '0', 'important');
          el.style.setProperty('bottom', 'auto', 'important');
          el.style.setProperty('left', '0', 'important');
          el.style.setProperty('right', 'auto', 'important');
          el.style.setProperty('position', 'fixed', 'important');
          el.style.setProperty('z-index', '99999', 'important');
          el.style.setProperty('transform', 'none', 'important');
          el.style.setProperty('margin', '0', 'important');
          
          var iframes = el.querySelectorAll('iframe');
          for (var j = 0; j < iframes.length; j++) {
            iframes[j].style.setProperty('top', '0', 'important');
            iframes[j].style.setProperty('bottom', 'auto', 'important');
            iframes[j].style.setProperty('left', '0', 'important');
            iframes[j].style.setProperty('right', 'auto', 'important');
          }
        }
      }
    } catch (e) {}
  }
  
  var count = 0;
  var interval = setInterval(function() {
    moveSocialBarToTop();
    count++;
    if (count >= 200) clearInterval(interval);
  }, 300);
  
  if (window.MutationObserver) {
    try {
      var observer = new MutationObserver(function() {
        moveSocialBarToTop();
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: false,
        attributes: true,
        attributeFilter: ['style', 'class']
      });
      setTimeout(function() { observer.disconnect(); }, 60000);
    } catch (e) {}
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', moveSocialBarToTop);
  }
  window.addEventListener('load', moveSocialBarToTop);
  moveSocialBarToTop();
})();
<\/script>`;
}

// ═══════════════════════════════════════════════════════════
// ✅ SPAM COMMENT FILTER
// ═══════════════════════════════════════════════════════════
function isSpamComment(text) {
  if (!text || typeof text !== 'string') return true;
  
  var lower = text.toLowerCase().trim();
  
  var urlPattern = /(https?:\/\/|www\.|\.com|\.net|\.org|\.in|\.xyz|\.top|\.info|\.ru|\.tk|bit\.ly|tinyurl|t\.co)/i;
  if (urlPattern.test(lower)) return true;
  
  var spamWords = [
    'buy now', 'click here', 'free money', 'casino', 'viagra', 'cialis',
    'porn', 'sex', 'xxx', 'adult', 'escort', 'loan', 'bitcoin', 'crypto',
    'make money', 'earn money', 'work from home', 'weight loss',
    'lottery', 'jackpot', 'winner', 'prize', 'free gift',
    'telegram', 'whatsapp', 'call now', 'contact me'
  ];
  for (var i = 0; i < spamWords.length; i++) {
    if (lower.indexOf(spamWords[i]) !== -1) return true;
  }
  
  var badWords = [
    'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'damn',
    'madarchod', 'bhenchod', 'chutiya', 'gandu', 'harami',
    'খানকি', 'মাদারচোদ', 'চোদ', 'গালি', 'শালা', 'কুত্তা'
  ];
  for (var j = 0; j < badWords.length; j++) {
    if (lower.indexOf(badWords[j]) !== -1) return true;
  }
  
  var specialCount = (text.match(/[!@#$%^&*()_+={}\[\]|\\:;"'<>,.?\/~`]/g) || []).length;
  if (specialCount > text.length * 0.3) return true;
  
  if (/(.)\1{5,}/.test(text)) return true;
  
  if (lower.length < 2) return true;
  if (lower.length > 1000) return true;
  
  return false;
}

async function hasUserCommented(env, newsId, deviceId) {
  try {
    const row = await env.DB.prepare(
      `SELECT id FROM news_comments 
       WHERE news_id = ? AND device_id = ? 
       LIMIT 1`
    ).bind(newsId, deviceId).first();
    return !!row?.id;
  } catch (e) {
    return false;
  }
}

async function removeInvalidTokens(env, invalidTokens, source = 'PUSH') {
  if (!invalidTokens || !invalidTokens.length) return 0;
  try {
    const placeholders = invalidTokens.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE token IN (${placeholders})`
    ).bind(...invalidTokens).run();
    const deleted = Number(result?.meta?.changes || invalidTokens.length);
    console.log(`[${source}] Removed ${deleted} invalid tokens`);
    return deleted;
  } catch (e) {
    console.warn(`[${source}] Failed:`, e?.message || String(e));
    return 0;
  }
}

function gonePage(relatedNews = []) {
  const relatedHtml = relatedNews.length ? `
    <div style="margin-top: 32px; text-align: left;">
      <h2 style="font-size: 18px; margin-bottom: 16px; color: #111;">📰 সাম্প্রতিক খবর</h2>
      <ul style="list-style: none; padding: 0;">
        ${relatedNews.map(n => `
          <li style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #eee;">
            <a href="https://ajkernews.in/news/${encodeURIComponent(n.id)}" 
               style="color: #007bff; text-decoration: none; font-size: 15px; font-weight: 600;">
              ${escapeHtml(n.headline || 'সংবাদ')}
            </a>
          </li>
        `).join('')}
      </ul>
    </div>
  ` : '';

  const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>খবরটি আর নেই - Ajker News</title>
<meta name="robots" content="noindex, follow">
<link rel="icon" type="image/x-icon" href="/public/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="/public/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/public/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/public/apple-touch-icon.png">
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family: Inter,-apple-system,BlinkMacSystemFont,sans-serif; }
  body { max-width: 600px; margin: 40px auto; padding: 20px; color: #111; }
  h1 { font-size: 28px; margin-bottom: 16px; text-align: center; }
  p { font-size: 16px; color: #666; line-height: 1.6; margin-bottom: 24px; text-align: center; }
  .btn { display: block; width: 100%; text-align: center; background: #007bff; color: #fff; padding: 14px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin-bottom: 12px; }
  .btn-secondary { background: #f2f2f2; color: #333; }
</style>
</head>
<body>
  <h1>📰 খবরটি আর নেই</h1>
  <p>এই খবরটি আমাদের আর্কাইভ থেকে সরিয়ে নেওয়া হয়েছে। নিচে সাম্প্রতিক খবর দেখুন।</p>
  
  <a href="https://ajkernews.in/" class="btn">🏠 সর্বশেষ খবর দেখুন</a>
  <a href="javascript:history.back()" class="btn btn-secondary">← পূর্ববর্তী পেজে ফিরে যান</a>

  ${relatedHtml}
</body>
</html>`;
  return new Response(html, {
    status: 410,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=86400",
      "X-Robots-Tag": "noindex, follow"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ═══════════════════════════════════════════════════════════
    // ✅ PUBLIC ASSETS REDIRECT (Logo, Favicon, Manifest)
    // ═══════════════════════════════════════════════════════════
    const publicRedirects = {
      "/favicon.ico": "/public/favicon.ico",
      "/favicon-16x16.png": "/public/favicon-16x16.png",
      "/favicon-32x32.png": "/public/favicon-32x32.png",
      "/apple-touch-icon.png": "/public/apple-touch-icon.png",
      "/android-chrome-192x192.png": "/public/android-chrome-192x192.png",
      "/android-chrome-512x512.png": "/public/android-chrome-512x512.png",
      "/manifest.json": "/public/manifest.json",
      "/adblock.js": "/public/adblock.js"
    };

    if (publicRedirects[url.pathname]) {
      return Response.redirect(new URL(publicRedirects[url.pathname], url).toString(), 301);
    }

    try {
      async function sha256(text) {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hashBuffer))
          .map(b => b.toString(16).padStart(2, '0')).join('');
      }

      async function getAdminSession(request, env) {
        const cookieHeader = request.headers.get("Cookie") || "";
        const cookies = Object.fromEntries(
          cookieHeader.split(";").map(c => c.trim().split("=").map(decodeURIComponent))
        );
        const token = cookies["admin_session"];
        if (!token) return null;
        try {
          return await env.DB.prepare(
            `SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ? LIMIT 1`
          ).bind(token, new Date().toISOString()).first() || null;
        } catch (e) { return null; }
      }

      function jsonWithCookie(data, status, cookieValue) {
        const headers = {
          ...corsHeaders(),
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "no-cache, no-store, must-revalidate"
        };
        if (cookieValue) headers["Set-Cookie"] = cookieValue;
        return new Response(JSON.stringify(data), { status, headers });
      }

      // Admin routes
      if (url.pathname === "/admin" && request.method === "GET") {
        const session = await getAdminSession(request, env);
        if (session) return Response.redirect(new URL("/admin/dashboard", url).toString(), 302);
        return new Response(getAdminLoginHTML(), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet"
          }
        });
      }

      if (url.pathname === "/admin/dashboard" && request.method === "GET") {
        const session = await getAdminSession(request, env);
        if (!session) return Response.redirect(new URL("/admin", url).toString(), 302);
        return new Response(getAdminDashboardHTML(), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet"
          }
        });
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        try {
          const { password } = await request.json();
          if (!password) return json({ success: false, error: "Password required" }, 400, 0);
          const passwordHash = await sha256(password);
          const expectedHash = env.ADMIN_PASSWORD_HASH;
          if (!expectedHash) return json({ success: false, error: "Admin not configured" }, 500, 0);
          if (passwordHash !== expectedHash) return json({ success: false, error: "Invalid password" }, 401, 0);

          const token = crypto.randomUUID() + "-" + crypto.randomUUID();
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

          await env.DB.prepare(
            `INSERT INTO admin_sessions (id, token, ip, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            crypto.randomUUID(), token,
            request.headers.get("CF-Connecting-IP") || "unknown",
            request.headers.get("User-Agent") || "unknown",
            expiresAt, new Date().toISOString()
          ).run();

          const cookie = `admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`;
          return jsonWithCookie({ success: true, redirect: "/admin/dashboard" }, 200, cookie);
        } catch (error) {
          return json({ success: false, error: error.message }, 500, 0);
        }
      }

      if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        const session = await getAdminSession(request, env);
        if (session) await env.DB.prepare(`DELETE FROM admin_sessions WHERE token = ?`).bind(session.token).run().catch(() => {});
        const cookie = `admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
        return jsonWithCookie({ success: true }, 200, cookie);
      }

      if (url.pathname === "/api/admin/list" && request.method === "GET") {
        const session = await getAdminSession(request, env);
        if (!session) return json({ success: false, error: "Unauthorized" }, 401, 0);
        try {
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
          const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10), 0);
          const newsId = url.searchParams.get("id") || null;
          const search = url.searchParams.get("search") || null;

          let query = `SELECT id, headline, summary, category, status, image_url, created_at FROM news WHERE status = 'published'`;
          let countQuery = `SELECT COUNT(*) AS total FROM news WHERE status = 'published'`;
          const binds = [];
          const countBinds = [];

          if (newsId) {
            query += ` AND id = ?`;
            countQuery += ` AND id = ?`;
            binds.push(newsId);
            countBinds.push(newsId);
          } else if (search) {
            query += ` AND headline LIKE ?`;
            countQuery += ` AND headline LIKE ?`;
            binds.push(`%${search}%`);
            countBinds.push(`%${search}%`);
          }

          query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
          binds.push(limit, offset);

          const rows = await env.DB.prepare(query).bind(...binds).all();
          const total = await env.DB.prepare(countQuery).bind(...countBinds).first();

          return json({
            success: true,
            count: (rows.results || []).length,
            total: Number(total?.total || 0),
            offset, limit,
            news: rows.results || []
          }, 200, 0);
        } catch (error) { return json({ success: false, error: error.message }, 500, 0); }
      }

      if (url.pathname === "/api/admin/update" && request.method === "POST") {
        const session = await getAdminSession(request, env);
        if (!session) return json({ success: false, error: "Unauthorized" }, 401, 0);
        try {
          const { id, updates } = await request.json();
          if (!id || !updates) return json({ success: false, error: "id and updates required" }, 400, 0);
          const allowed = ["headline", "summary", "status"];
          const fields = Object.keys(updates).filter(k => allowed.includes(k));
          if (!fields.length) return json({ success: false, error: "No valid fields" }, 400, 0);
          const sql = fields.map(k => `${k} = ?`).join(", ");
          const vals = fields.map(k => updates[k]);
          await env.DB.prepare(`UPDATE news SET ${sql} WHERE id = ?`).bind(...vals, id).run();
          return json({ success: true, message: "Updated", id }, 200, 0);
        } catch (error) { return json({ success: false, error: error.message }, 500, 0); }
      }

      if (url.pathname === "/api/admin/comments" && request.method === "GET") {
        const session = await getAdminSession(request, env);
        if (!session) return json({ success: false, error: "Unauthorized" }, 401, 0);
        try {
          const newsId = url.searchParams.get("newsId") || null;
          let query = `SELECT nc.id, nc.news_id, nc.author_name, nc.comment_text, nc.created_at, n.headline 
                       FROM news_comments nc
                       LEFT JOIN news n ON n.id = nc.news_id`;
          const binds = [];
          if (newsId) {
            query += ` WHERE nc.news_id = ?`;
            binds.push(newsId);
          }
          query += ` ORDER BY nc.created_at DESC LIMIT 100`;
          const rows = await env.DB.prepare(query).bind(...binds).all();
          return json({ success: true, comments: rows.results || [] }, 200, 0);
        } catch (error) { return json({ success: false, error: error.message }, 500, 0); }
      }

      if (url.pathname === "/api/admin/comment-update" && request.method === "POST") {
        const session = await getAdminSession(request, env);
        if (!session) return json({ success: false, error: "Unauthorized" }, 401, 0);
        try {
          const { id, updates } = await request.json();
          if (!id || !updates) return json({ success: false, error: "id and updates required" }, 400, 0);
          const allowed = ["comment_text", "author_name"];
          const fields = Object.keys(updates).filter(k => allowed.includes(k));
          if (!fields.length) return json({ success: false, error: "No valid fields" }, 400, 0);
          const sql = fields.map(k => `${k} = ?`).join(", ");
          const vals = fields.map(k => updates[k]);
          await env.DB.prepare(`UPDATE news_comments SET ${sql} WHERE id = ?`).bind(...vals, id).run();
          return json({ success: true, message: "Comment updated", id }, 200, 0);
        } catch (error) { return json({ success: false, error: error.message }, 500, 0); }
      }

      if (url.pathname === "/api/admin/comment-delete" && request.method === "POST") {
        const session = await getAdminSession(request, env);
        if (!session) return json({ success: false, error: "Unauthorized" }, 401, 0);
        try {
          const { id } = await request.json();
          if (!id) return json({ success: false, error: "id required" }, 400, 0);
          await env.DB.prepare(`DELETE FROM news_comments WHERE id = ?`).bind(id).run();
          return json({ success: true, message: "Deleted" }, 200, 0);
        } catch (error) { return json({ success: false, error: error.message }, 500, 0); }
      }

      if (url.pathname === "/sitemap.xml") return await generateSitemap(env);
      if (url.pathname === "/news-sitemap.xml") return await generateNewsSitemap(env);
      if (url.pathname === "/rss.xml") return await generateRSS(env);
      if (url.pathname === "/robots.txt") return generateRobotsTxt(env);

      if (url.pathname === "/api/live" && request.method === "GET") {
        return new Response("SSE disabled for performance", { 
          status: 200, 
          headers: { "Content-Type": "text/plain" } 
        });
      }

      const userAgent = request.headers.get("User-Agent") || "";
      const isBot = BOT_REGEX.test(userAgent);

      if (url.pathname.startsWith("/news/") && request.method === "GET") {
        const articleId = decodeURIComponent(url.pathname.slice(6).split("/")[0] || "").trim();
        if (!articleId) return Response.redirect("https://ajkernews.in/", 302);
        return await serveArticlePage(articleId, env, request);
      }

      if (env.INDEXNOW_KEY && url.pathname === `/${env.INDEXNOW_KEY}.txt`) {
        return new Response(env.INDEXNOW_KEY, {
          status: 200,
          headers: { "content-type": "text/plain; charset=UTF-8", "Cache-Control": "public, max-age=86400" }
        });
      }

      if (url.pathname === "/" && request.method === "GET" && isBot) {
        const articleId = url.searchParams.get("id");
        if (articleId) return await serveArticlePage(articleId, env, request);
        const cat = url.searchParams.get("category");
        if (cat && cat !== "top" && cat !== "all") return await serveBotCategoryPage(cat, env, request);
        return await serveBotHomepage(env, request);
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

      if (url.pathname === "/api/ads-config" && request.method === "GET") {
        return json({
          success: true,
          publisherId: ADS_CONFIG.publisherId || "",
          popunderUrl: ADS_CONFIG.popunderUrl || ""
        }, 200, 60);
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
        return json(result, 200, 0);
      }

      if (url.pathname === "/api/push-click" && request.method === "POST") {
        return await handlePushClick(request, env);
      }

      if (url.pathname === "/api/push-stats" && request.method === "GET") {
        return await handlePushStats(env);
      }

      if (url.pathname === "/api/push-logs" && request.method === "GET") {
        return await handlePushLogs(env, url);
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

      if (url.pathname === "/api/debug-tokens" && request.method === "GET") {
        const secret = url.searchParams.get("secret");
        const validSecret = env.DEBUG_TOKENS_SECRET || "ajkernews-push-2026";
        if (secret !== validSecret) {
          return json({ success: false, error: "Unauthorized" }, 401, 0);
        }
        try {
          const subs = await env.DB.prepare(
            `SELECT id, token, created_at FROM push_subscriptions WHERE token IS NOT NULL AND token != '' ORDER BY created_at DESC LIMIT 100`
          ).all();
          return json({
            success: true,
            count: (subs.results || []).length,
            tokens: (subs.results || []).map(r => ({
              id: r.id, token: r.token, created_at: r.created_at
            }))
          }, 200, 0);
        } catch (error) {
          return json({ success: false, error: error.message }, 500, 0);
        }
      }

      if (url.pathname === "/api/debug" && request.method === "GET") {
        try {
          const stats = await env.DB.prepare(`SELECT status, COUNT(*) AS count FROM news GROUP BY status`).all();
          const recent = await env.DB.prepare(`SELECT id, headline, status, created_at, published_at FROM news ORDER BY created_at DESC LIMIT 10`).all();
          const pushSubs = await env.DB.prepare(`SELECT COUNT(*) AS total FROM push_subscriptions`).first();
          const hasServiceAccount = !!env.FIREBASE_SERVICE_ACCOUNT_JSON;

          let sentStats = { total: 0, today: 0 };
          try {
            const totalSent = await env.DB.prepare(`SELECT COUNT(*) AS total FROM push_sent`).first();
            const todaySent = await env.DB.prepare(
              `SELECT COUNT(*) AS total FROM push_sent WHERE sent_at >= datetime('now', '-1 day')`
            ).first();
            sentStats = { total: Number(totalSent?.total || 0), today: Number(todaySent?.total || 0) };
          } catch (e) {}

          return json({
            success: true,
            stats: stats.results || [],
            recent: recent.results || [],
            push: {
              subscribers: Number(pushSubs?.total || 0),
              hasServiceAccount: hasServiceAccount,
              sent: sentStats
            }
          }, 200, 0);
        } catch (error) {
          return json({ success: false, error: error.message }, 500, 0);
        }
      }

      if (url.pathname === "/api/push-test" && request.method === "POST") {
        try {
          const latest = await env.DB.prepare(
            `SELECT id, headline, summary, image_url, score, category, created_at FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT 1`
          ).first();
          if (!latest) return json({ success: false, error: "No published news found" }, 400, 0);

          const subs = await env.DB.prepare(
            `SELECT token FROM push_subscriptions WHERE token IS NOT NULL AND token != '' ORDER BY created_at DESC LIMIT ${NOTIFICATION_CONFIG.MAX_BATCH_SIZE}`
          ).all();
          const tokens = (subs.results || []).map(s => s.token).filter(Boolean);

          if (!tokens.length) {
            return json({ success: false, error: "No subscribers found" }, 400, 0);
          }

          const isBreaking = isBreakingNews(latest);
          const result = await sendSinglePush(env, latest, tokens, isBreaking);

          return json({
            success: true,
            message: "Push test completed",
            newsId: latest.id,
            headline: latest.headline,
            isBreaking: isBreaking,
            subscribers: tokens.length,
            fcmResult: result
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
    const istHour = getISTHour();
    console.log(`[CRON] ${cron} started | IST Hour: ${istHour}`);

    try {
      await ensureTablesOnce(env);

      const DIGEST_CRONS = {
        "45 2 * * *":  8,
        "45 7 * * *":  13,
        "45 12 * * *": 18,
        "45 15 * * *": 21
      };

      if (DIGEST_CRONS[cron] !== undefined) {
        console.log(`[DIGEST] Cron=${cron} → IST hour=${DIGEST_CRONS[cron]}`);
        await sendDigest(env, DIGEST_CRONS[cron]);
        return;
      }

      if (cron === "0 */2 * * *") {
        let result;
        try {
          result = await updateNews(env);
          console.log("[CRON-NEWS] Result:", JSON.stringify(result));
        } catch (error) {
          console.error("[CRON-NEWS] updateNews failed:", error?.message || String(error));
          return;
        }

        if (result.published > 0 && Array.isArray(result.newNewsIds) && result.newNewsIds.length && !isQuietHours()) {
          try {
            const placeholders = result.newNewsIds.map(() => "?").join(",");
            const breakingCandidate = await env.DB.prepare(
              `SELECT id, headline, summary, image_url, score, category, created_at 
               FROM news
               WHERE id IN (${placeholders}) 
                 AND status = 'published'
                 AND score >= ?
               ORDER BY score DESC, created_at DESC LIMIT 1`
            ).bind(...result.newNewsIds, NOTIFICATION_CONFIG.BREAKING_SCORE_THRESHOLD).first();

            if (breakingCandidate) {
              const todayStart = new Date();
              todayStart.setUTCHours(0, 0, 0, 0);
              const todayCount = await env.DB.prepare(
                `SELECT COUNT(DISTINCT news_id) AS c FROM push_log 
                 WHERE status = 'sent' 
                   AND title LIKE '🔴 ব্রেকিং%'
                   AND sent_at >= ?`
              ).bind(todayStart.toISOString()).first();

              const sentToday = Number(todayCount?.c || 0);

              if (sentToday < NOTIFICATION_CONFIG.MAX_BREAKING_PER_DAY) {
                console.log(`[BREAKING] score=${breakingCandidate.score}: ${breakingCandidate.headline}`);
                ctx.waitUntil(
                  sendBreakingAlert(env, breakingCandidate).catch(error => {
                    console.error("[BREAKING] Send error:", error?.message || String(error));
                  })
                );
              }
            }
          } catch (e) {
            console.warn('[BREAKING] Failed:', e?.message);
          }
        }

        try {
          const recent = await env.DB.prepare(
            `SELECT id FROM news WHERE status = 'published' AND created_at >= datetime('now', '-6 hours') ORDER BY created_at DESC LIMIT 50`
          ).all();
          const ids = (recent.results || []).map(r => r.id);
          if (ids.length) {
            const indexResult = await fastIndexNews(env, ids);
            console.log(`[FAST-INDEX] ${ids.length} URLs:`, JSON.stringify(indexResult));
          }
        } catch (error) {
          console.error("[FAST-INDEX] Failed:", error?.message || String(error));
        }

        try { await cleanOldCandidates(env.DB); } catch (e) {}
        try { await cleanRejectedNews(env.DB); } catch (e) {}
        try {
          await env.DB.prepare(`DELETE FROM push_subscriptions WHERE created_at < datetime('now', '-90 days')`).run();
          await env.DB.prepare(`DELETE FROM push_clicks WHERE created_at < datetime('now', '-30 days')`).run();
          await env.DB.prepare(`DELETE FROM push_log WHERE sent_at < datetime('now', '-7 days')`).run();
          await env.DB.prepare(`DELETE FROM push_sent WHERE sent_at < datetime('now', '-7 days')`).run();
          await env.DB.prepare(`DELETE FROM push_digest_log WHERE sent_at < datetime('now', '-30 days')`).run();
          await env.DB.prepare(`DELETE FROM live_events WHERE created_at < datetime('now', '-1 day')`).run();
          await env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at < datetime('now')`).run();
        } catch (error) {
          console.warn("[CLEAN] Cleanup failed:", error?.message || String(error));
        }

        const currentUtcHour = new Date().getUTCHours();
        if ([0, 6, 12, 18].includes(currentUtcHour)) {
          try {
            const cleanupResult = await enforceNewsLimit(env.DB);
            console.log(`[CRON-CLEAN] News: ${cleanupResult.deleted} deleted`);
            if (cleanupResult.deleted > 0) {
              try {
                await purgeNewsApiCache("https://ajkernews.in");
                for (const id of cleanupResult.deletedIds || []) {
                  await purgeArticleCache("https://ajkernews.in", id);
                }
              } catch (e) {}
            }
          } catch (error) {
            console.error("[CRON-CLEAN] Failed:", error?.message || String(error));
          }

          try {
            await Promise.allSettled([
              fetch(`https://www.bing.com/ping?sitemap=${encodeURIComponent("https://ajkernews.in/sitemap.xml")}`).catch(() => {}),
              fetch(`https://www.bing.com/ping?sitemap=${encodeURIComponent("https://ajkernews.in/news-sitemap.xml")}`).catch(() => {})
            ]);
          } catch (e) {}
        }

        return;
      }

      console.log(`[CRON] Unknown cron: ${cron} — no action`);
    } catch (error) {
      console.error(`[CRON] Fatal:`, error?.message || error?.stack || String(error));
    }
  }
};

async function sendDigest(env, istHour) {
  if (isQuietHours()) return;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return;

  const subs = await env.DB.prepare(
    `SELECT token FROM push_subscriptions WHERE token IS NOT NULL AND token != '' ORDER BY created_at DESC LIMIT ${NOTIFICATION_CONFIG.MAX_BATCH_SIZE}`
  ).all();

  const tokens = (subs.results || []).map(s => s.token).filter(Boolean);
  if (!tokens.length) return;

  const recentNews = await env.DB.prepare(
    `SELECT id, headline, summary, image_url, score, category, created_at FROM news
     WHERE status = 'published' AND created_at >= datetime('now', '-24 hours')
     ORDER BY score DESC, created_at DESC LIMIT 20`
  ).all();

  const candidates = recentNews.results || [];
  if (!candidates.length) return;

  const candidateIds = candidates.map(c => c.id);
  const sentRows = await env.DB.prepare(
    `SELECT news_id FROM push_sent WHERE news_id IN (${candidateIds.map(() => "?").join(",")})`
  ).bind(...candidateIds).all();
  const sentIds = new Set((sentRows.results || []).map(r => r.news_id));

  const unsentNews = candidates
    .filter(n => !sentIds.has(n.id))
    .slice(0, NOTIFICATION_CONFIG.DIGEST_NEWS_COUNT);

  if (unsentNews.length < NOTIFICATION_CONFIG.DIGEST_MIN_NEWS) {
    console.log(`[DIGEST] Only ${unsentNews.length} fresh news — skipping`);
    return;
  }

  const digestType = getDigestType(istHour);
  const label = getDigestLabel(istHour);
  const topNews = unsentNews[0];
  const body = unsentNews.map(n => `• ${n.headline}`).join('\n').slice(0, 200);
  const targetUrl = `https://ajkernews.in/news/${topNews.id}?from=push&digest=${digestType}`;
  const tag = `digest-${digestType}`;  // ✅ Fixed tag (no Date.now())

  const result = await sendDigestPush(env, {
    title: label, body, image: topNews.image_url, url: targetUrl, tag,
    newsIds: unsentNews.map(n => n.id)
  }, tokens);

  try {
    await env.DB.prepare(
      `INSERT INTO push_digest_log (id, digest_type, news_count, sent_count, sent_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), digestType, unsentNews.length, result.sent, new Date().toISOString()).run();
  } catch (e) {}

  const sentAt = new Date().toISOString();
  const insertStmts = [];
  for (const news of unsentNews) {
    for (const token of tokens) {
      insertStmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO push_sent (id, news_id, token, sent_at) VALUES (?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), news.id, token.slice(0, 30), sentAt)
      );
    }
  }
  if (insertStmts.length) try { await env.DB.batch(insertStmts); } catch (e) {}

  await removeInvalidTokens(env, result.invalidTokens, 'DIGEST');
}

async function sendBreakingAlert(env, news) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return;  // ✅ Added FCM check

  const subs = await env.DB.prepare(
    `SELECT token FROM push_subscriptions WHERE token IS NOT NULL AND token != '' ORDER BY created_at DESC LIMIT ${NOTIFICATION_CONFIG.MAX_BATCH_SIZE}`
  ).all();

  const tokens = (subs.results || []).map(s => s.token).filter(Boolean);
  if (!tokens.length) return;

  const alreadySent = await env.DB.prepare(
    `SELECT id FROM push_sent WHERE news_id = ? LIMIT 1`
  ).bind(news.id).first();
  if (alreadySent) return;

  const title = `🔴 ব্রেকিং: ${String(news.headline || "").slice(0, 150)}`;
  const body = String(news.summary || "এখনই পড়ুন →").slice(0, 150);
  const targetUrl = `https://ajkernews.in/news/${news.id}?from=push&breaking=1`;
  const tag = `breaking-${news.id}`;  // ✅ Fixed tag (no Date.now())

  const result = await sendDigestPush(env, {
    title, body, image: news.image_url, url: targetUrl, tag,
    newsIds: [news.id], isBreaking: true
  }, tokens);

  await removeInvalidTokens(env, result.invalidTokens, 'PUSH');

  const sentAt = new Date().toISOString();
  const insertStmts = tokens.map(token => env.DB.prepare(
    `INSERT OR IGNORE INTO push_sent (id, news_id, token, sent_at) VALUES (?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), news.id, token.slice(0, 30), sentAt));
  if (insertStmts.length) try { await env.DB.batch(insertStmts); } catch (e) {}
}

async function sendDigestPush(env, payload, tokens) {
  const result = {
    accessTokenObtained: false, tokenExchangeError: null,
    sent: 0, failed: 0, unregistered: 0, invalidTokens: [], errors: []
  };

  let credentials;
  try {
    credentials = await getFcmCredentials(env);
    result.accessTokenObtained = true;
  } catch (e) {
    result.tokenExchangeError = e.message;
    console.error('[FCM] Credentials failed:', e.message);
    return result;
  }

  const { accessToken, projectId } = credentials;
  const isBreaking = !!payload.isBreaking;
  const ttl = isBreaking ? NOTIFICATION_CONFIG.BREAKING_TTL_SECONDS : NOTIFICATION_CONFIG.REGULAR_TTL_SECONDS;
  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const sentAt = new Date().toISOString();
  const logStmts = [];

  for (const token of tokens) {
    const title = String(payload.title || "Ajker News");
    const body = String(payload.body || "নতুন খবর এসেছে");
    const image = String(payload.image || "");
    const notifTag = String(payload.tag || "ajker-news");
    const targetUrl = String(payload.url || "https://ajkernews.in/");

    const message = {
      message: {
        token: token,
        data: {
          title: title,
          body: body,
          image: image,
          url: targetUrl,
          notificationId: notifTag,
          isBreaking: isBreaking ? "1" : "0"
        },
        android: {
          priority: "high",
          notification: {
            title: title,
            body: body,
            icon: "stock_ticker_update",
            color: "#e53935",
            tag: notifTag,
            sound: "default",
            image: image,
            click_action: "FCM_PLUGIN_ACTIVITY"
          }
        },
        webpush: {
          headers: {
            Urgency: "high",
            TTL: String(ttl)
          },
          fcmOptions: { link: targetUrl },
          data: {
            title: title,
            body: body,
            image: image,
            url: targetUrl,
            notificationId: notifTag,
            isBreaking: isBreaking ? "1" : "0"
          }
        }
      }
    };

    try {
      const res = await fetch(fcmUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(message)
      });

      if (res.ok) {
        result.sent++;
        logStmts.push(
          env.DB.prepare(
            `INSERT INTO push_log (id, news_id, token, status, title, sent_at) VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            crypto.randomUUID(),
            payload.newsIds?.[0] || null,
            token.slice(0, 30),
            'sent',
            title.slice(0, 100),
            sentAt
          )
        );
      } else {
        const errData = await res.json().catch(() => ({}));
        result.failed++;
        const errCode = errData?.error?.details?.[0]?.errorCode
                     || errData?.error?.status
                     || 'unknown';
        result.errors.push(`${errCode}: ${token.slice(0, 15)}...`);

        if (errCode === 'UNREGISTERED' || errCode === 'NOT_FOUND') {
          result.unregistered++;
          result.invalidTokens.push(token);
        }

        logStmts.push(
          env.DB.prepare(
            `INSERT INTO push_log (id, news_id, token, status, error, title, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            crypto.randomUUID(),
            payload.newsIds?.[0] || null,
            token.slice(0, 30),
            'failed',
            errCode,
            title.slice(0, 100),
            sentAt
          )
        );
      }
    } catch (e) {
      result.failed++;
      result.errors.push(`Network: ${e.message}`);
    }
  }

  if (logStmts.length) {
    try { await env.DB.batch(logStmts); } catch (e) {}
  }

  return result;
}

async function sendSinglePush(env, news, tokens, isBreaking) {
  const title = String(news.headline || "নতুন খবর").slice(0, 180);
  const body = String(news.summary || "বিস্তারিত জানতে ক্লিক করুন").slice(0, 180);
  const targetUrl = `https://ajkernews.in/news/${news.id}?from=push`;
  const tag = `${isBreaking ? 'breaking' : 'news'}-${news.id}`;  // ✅ Fixed tag (no Date.now())

  const result = await sendDigestPush(env, {
    title, body, image: news.image_url, url: targetUrl, tag,
    newsIds: [news.id], isBreaking
  }, tokens);

  await removeInvalidTokens(env, result.invalidTokens, 'PUSH-TEST');

  return result;
}

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
  } catch (error) {}

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
  } catch (error) {}

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
  } catch (error) {}

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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini total timeout')), 120000))
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
    } catch (e) {}
  }

  const searchUpdates = [];
  for (const id of publishedIds) {
    try {
      const row = await env.DB.prepare(`SELECT headline, summary, main_topic, category, source_name FROM news WHERE id = ? AND status = 'published'`).bind(id).first();
      if (!row) continue;
      const searchText = toTransliterated([row.headline, row.summary, row.main_topic, row.category, row.source_name].filter(Boolean).join(" "));
      searchUpdates.push(env.DB.prepare(`UPDATE news SET search_text = ? WHERE id = ?`).bind(searchText, id));
    } catch (e) {}
  }

  if (searchUpdates.length) {
    try {
      await env.DB.batch(searchUpdates);
    } catch (error) {}
  }

  let cleanupResult = { deleted: 0, total: 0, deletedIds: [] };
  try {
    cleanupResult = await enforceNewsLimit(env.DB);
  } catch (error) {}

  for (const id of cleanupResult.deletedIds || []) {
    try {
      await env.DB.prepare(`DELETE FROM news_loves WHERE news_id = ?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM news_comments WHERE news_id = ?`).bind(id).run();
    } catch (e) {}
  }

  if (publishResult.published > 0 || cleanupResult.deleted > 0) {
    try {
      await purgeNewsApiCache("https://ajkernews.in");
      for (const id of publishedIds) await purgeArticleCache("https://ajkernews.in", id);
      for (const id of cleanupResult.deletedIds || []) await purgeArticleCache("https://ajkernews.in", id);
    } catch (error) {}
  }

  if (publishedIds.length) {
    try {
      await fastIndexNews(env, publishedIds);
    } catch (error) {}

    try {
      const eventPayload = JSON.stringify({
        ids: publishedIds,
        count: publishedIds.length,
        ts: Date.now()
      });
      await env.DB.prepare(
        `INSERT INTO live_events (id, event_type, payload, created_at) VALUES (?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        'news_published',
        eventPayload,
        new Date().toISOString()
      ).run();
    } catch (e) {}
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

async function serveBotHomepage(env, request) {
  return await serveListingPage(env, "top", null, request);
}

async function serveBotCategoryPage(category, env, request) {
  return await serveListingPage(env, category, null, request);
}

async function serveListingPage(env, category, searchQuery, request) {
  try {
    const userAgent = request?.headers.get("User-Agent") || "";
    const isBot = BOT_REGEX.test(userAgent);

    const adScripts = isBot ? "" : getAdsterraScripts();
    const bannerContainer = isBot ? "" : getNativeBannerContainer();
    const adultBlocker = isBot ? "" : getAdultBlockerScript();
    const socialBarScript = isBot ? "" : getSocialBarTopScript();

    const catLabel = {
      top:'সেরা খবর', trending:'ট্রেন্ডিং', west_bengal:'পশ্চিমবঙ্গ',
      kolkata:'কলকাতা', india:'ভারত', world:'বিশ্ব', business:'ব্যবসা',
      sports:'খেলা', politics:'রাজনীতি', technology:'প্রযুক্তি',
      entertainment:'বিনোদন', crime:'অপরাধ', district:'জেলা', general:'সাধারণ'
    };

    const catDescription = {
      top: 'কলকাতা, পশ্চিমবঙ্গ, ভারত ও বিশ্বের সর্বশেষ ও সেরা বাংলা খবর।',
      trending: 'ট্রেন্ডিং বাংলা খবর - সবচেয়ে বেশি পড়া সংবাদ।',
      all: 'সব বাংলা খবর - রাজনীতি, খেলা, বিনোদন, ব্যবসা।',
      west_bengal: 'পশ্চিমবঙ্গের সর্বশেষ খবর।',
      kolkata: 'কলকাতার সর্বশেষ খবর।',
      india: 'ভারতের সর্বশেষ খবর।',
      world: 'বিশ্বের সর্বশেষ খবর।',
      business: 'ব্যবসা ও অর্থনীতির খবর।',
      sports: 'খেলার সর্বশেষ খবর।',
      politics: 'রাজনীতির সর্বশেষ খবর।',
      technology: 'প্রযুক্তির সর্বশেষ খবর।',
      entertainment: 'বিনোদনের সর্বশেষ খবর।',
      crime: 'অপরাধের সর্বশেষ খবর।',
      district: 'জেলার সর্বশেষ খবর।',
      general: 'সাধারণ বাংলা খবর।'
    };
    const pageDescription = searchQuery 
      ? `সার্চ "${searchQuery}" এর ফলাফল - Ajker News।` 
      : (catDescription[category] || catDescription.top);

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

    const cacheControl = isBot 
      ? "public, s-maxage=3600, stale-while-revalidate=7200"
      : "public, s-maxage=300, stale-while-revalidate=600, max-age=0, must-revalidate";

    const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(pageTitle)} | Ajker News</title>
<meta name="description" content="${escapeHtml(pageDescription)}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" type="image/x-icon" href="/public/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="/public/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/public/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/public/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(pageTitle)} | Ajker News">
<meta property="og:description" content="${escapeHtml(pageDescription)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="https://ajkernews.in/logo.png">
<script type="application/ld+json">${itemListLd}</script>
${adScripts}
${socialBarScript}
</head>
<body style="max-width:820px;margin:0 auto;padding:20px;font-family:Inter,-apple-system,sans-serif;color:#111;">
${adultBlocker}
<header>
  <h1 style="font-size:28px;margin:0 0 6px;"><a href="/" style="color:#111;text-decoration:none;">Ajker News</a></h1>
  <p style="color:#666;font-size:15px;margin:0 0 16px;">${escapeHtml(pageTitle)}</p>
  <nav style="margin-bottom:24px;">${catNavHtml}</nav>
</header>
<main>${newsHtml}</main>
${bannerContainer}
<footer style="margin-top:40px;padding-top:20px;border-top:1px solid #eee;text-align:center;color:#888;font-size:13px;">
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
        "Cache-Control": cacheControl,
        "X-Robots-Tag": "index, follow, max-image-preview:large"
      }
    });
  } catch (error) {
    console.error("Listing page error:", error?.message || String(error));
    return new Response("Error loading content", { status: 500 });
  }
}

async function serveArticlePage(id, env, request) {
  const safeId = String(id || "").trim();
  if (!safeId) return Response.redirect("https://ajkernews.in/", 302);

  const userAgent = request?.headers.get("User-Agent") || "";
  const isBot = BOT_REGEX.test(userAgent);

  const adScripts = isBot ? "" : getAdsterraScripts();
  const bannerContainer = isBot ? "" : getNativeBannerContainer();
  const adultBlocker = isBot ? "" : getAdultBlockerScript();
  const socialBarScript = isBot ? "" : getSocialBarTopScript();
  const articlePopunder = isBot ? "" : getArticlePopunderScript();

  const result = await env.DB.prepare(
    `SELECT headline, summary, main_topic, image_url, published_at, created_at, source_name, source_url, category FROM news WHERE id = ? AND status = 'published' LIMIT 1`
  ).bind(safeId).first();

  if (!result) {
    let relatedNews = [];
    try {
      const related = await env.DB.prepare(
        `SELECT id, headline FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT 5`
      ).all();
      relatedNews = related?.results || [];
    } catch (e) {}
    return gonePage(relatedNews);
  }

  let loveCount = 0;
  try {
    const loveRow = await env.DB.prepare(`SELECT COUNT(*) AS count FROM news_loves WHERE news_id = ?`).bind(safeId).first();
    loveCount = Number(loveRow?.count || 0);
  } catch (e) {}

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
    formattedDate = d.toLocaleDateString('en-US', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
    }) + ' • ' + d.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
    });
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

  let recentNews = [];
  try {
    const recent = await env.DB.prepare(
      `SELECT id, headline FROM news WHERE status = 'published' AND id != ? ORDER BY created_at DESC LIMIT 4`
    ).bind(safeId).all();
    recentNews = recent?.results || [];
  } catch (e) {}

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

  const recentHtml = recentNews.length ? `
  <aside class="related-box">
    <h3>সাম্প্রতিক খবর</h3>
    <ul>
      ${recentNews.map(n => `<li><a href="https://ajkernews.in/news/${encodeURIComponent(n.id)}">${escapeHtml(n.headline || "")}</a></li>`).join("")}
    </ul>
  </aside>` : "";

  const cacheControl = isBot 
    ? "public, s-maxage=3600, stale-while-revalidate=7200"
    : "public, s-maxage=300, stale-while-revalidate=600, max-age=0, must-revalidate";

  const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
<title>${escapeHtml(title)} - Ajker News</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" type="image/x-icon" href="/public/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="/public/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/public/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/public/apple-touch-icon.png">
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
${adScripts}
${socialBarScript}
${articlePopunder}
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  html { scroll-behavior: smooth; font-size: 16px; -webkit-text-size-adjust: 100%; }
  body { background:#ffffff; color:#111111; -webkit-font-smoothing:antialiased; padding-bottom:20px; max-width: 100vw; overflow-x: hidden; }
  .header { position:sticky; top:0; z-index:1000; display:flex; align-items:center; justify-content:space-between; padding:12px 16px; min-height:60px; background:#ffffff; border-bottom:1px solid #e0e0e0; }
  .header-left { display:flex; align-items:center; gap:10px; min-width:0; flex-shrink:1; }
  .back-btn { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; background:transparent; border:none; cursor:pointer; padding:4px; border-radius:50%; transition:background 0.15s; text-decoration:none; flex-shrink:0; }
  .back-btn svg { width:22px; height:22px; stroke:#111; stroke-width:2.2; fill:none; stroke-linecap:round; stroke-linejoin:round; }
  .header-logo { height:28px; width:auto; object-fit:contain; flex-shrink:0; }
  .header-title { font-size:24px; line-height:1; font-weight:700; color:#111111; white-space:nowrap; letter-spacing:-0.3px; overflow:hidden; text-overflow:ellipsis; }
  .article-main { padding:16px; max-width: min(820px, 95vw); margin:0 auto; }
  .article-cat { display:inline-block; font-size:12px; color:#f44336; font-weight:700; margin-bottom:8px; text-decoration:none; }
  .article-h1 { font-size:24px; line-height:1.35; margin:0 0 14px; color:#111; font-weight:700; }
  .article-img { width:100%; height:auto; border-radius:8px; display:block; margin:0 0 18px; background:#f3f3f3; }
  .article-body { font-size:17px; color:#222; line-height:1.85; }
  .article-body p { margin-bottom:14px; }
  .article-source-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-top:22px; padding-top:16px; padding-bottom:16px; border-top:1px solid #e8e8e8; border-bottom:1px solid #e8e8e8; }
  .article-source-link { color:#007bff; text-decoration:none; font-weight:600; font-size:16px; }
  .article-date { color:#999999; font-size:14px; font-weight:500; }
  .article-actions-row { display:flex; gap:20px; margin-top:12px; padding-top:10px; border-top:1px solid #f0f0f0; }
  .action-btn-art { display:flex; align-items:center; gap:5px; background:none; border:none; color:#666; font-size:14px; cursor:pointer; padding:0; }
  .action-btn-art svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:2; }
  .action-btn-art.loved svg { fill:#e74c3c !important; stroke:#e74c3c !important; }
  .action-num { font-size:12px; color:#555; font-weight:600; }
  .related-box { margin:32px 0 0; padding-top:22px; border-top:1px solid #eee; }
  .related-box h3 { font-size:18px; margin:0 0 14px; color:#111; font-weight:700; }
  .related-box ul { list-style:none; padding:0; margin:0; }
  .related-box li { margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid #f5f5f5; }
  .related-box a { color:#111; text-decoration:none; font-size:15px; line-height:1.55; font-weight:600; }
  .article-footer { margin:36px 16px 0; padding-top:22px; border-top:1px solid #eee; text-align:center; color:#888; font-size:13px; }
  .article-footer a { color:#555; text-decoration:none; font-weight:600; letter-spacing:0.5px; }
  #artCommentModal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:2000; align-items:center; justify-content:center; padding:16px; }
  #artCommentModal.active { display:flex; }
  #artCommentModal .modal-box { background:#fff; border-radius:12px; width:100%; max-width:520px; max-height:85vh; display:flex; flex-direction:column; overflow:hidden; }
  #artCommentModal .modal-header { display:flex; justify-content:space-between; align-items:center; padding:14px 16px; border-bottom:1px solid #eee; flex-shrink:0; }
  #artCommentModal .modal-header h3 { font-size:17px; font-weight:700; margin:0; }
  #artCommentModal .modal-close { background:none; border:none; font-size:26px; cursor:pointer; color:#888; line-height:1; padding:0 6px; }
  #artCommentModal .modal-form { padding:12px 16px; border-top:1px solid #eee; background:#fafafa; flex-shrink:0; }
  #artCommentModal .modal-form input, #artCommentModal .modal-form textarea { width:100%; padding:9px 12px; border:1px solid #ddd; border-radius:6px; margin-bottom:8px; font-size:14px; outline:none; font-family:inherit; }
  #artCommentModal .modal-form textarea { height:70px; resize:vertical; }
  #artCommentModal .modal-form button { background:#000; color:#fff; border:none; padding:10px 20px; border-radius:6px; font-weight:600; cursor:pointer; font-size:14px; }
  #artCommentModal .modal-list { padding:14px 16px; overflow-y:auto; flex:1; -webkit-overflow-scrolling:touch; }
  @media (max-width:480px) {
    .header { padding:8px 12px; min-height:54px; }
    .header-title { font-size:20px; }
    .header-logo { height:24px; }
    .back-btn { width:32px; height:32px; }
    .back-btn svg { width:20px; height:20px; }
    .article-main { padding:12px; }
    .article-h1 { font-size:21px; }
    .article-body { font-size:16px; }
    .article-source-link { font-size:15px; }
    .article-date { font-size:13px; }
  }
</style>
</head>
<body>
${adultBlocker}
<div class="header">
  <div class="header-left">
    <a href="https://ajkernews.in/" class="back-btn" aria-label="Back to home">
      <svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
    </a>
    <img src="/logo.png" class="header-logo" alt="Ajker News">
    <span class="header-title">Ajker News</span>
  </div>
  <div class="header-right"></div>
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
      ${bannerContainer}
    </div>
    <div class="article-source-row">
      <a class="article-source-link" href="${escapeHtml(result.source_url || '#')}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(sourceDomain)}</a>
      <span class="article-date">${escapeHtml(formattedDate)}</span>
    </div>
    <div class="article-actions-row">
      <button type="button" class="action-btn-art" id="artCommentBtn" aria-label="Comment">
        <svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      </button>
      <button type="button" class="action-btn-art" id="artLoveBtn" aria-label="Love">
        <svg viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        <span class="action-num" id="artLoveCount">${loveCount}</span>
      </button>
      <button type="button" class="action-btn-art" id="artShareBtn" aria-label="Share">
        <svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      </button>
    </div>
  </article>
  ${recentHtml}
</main>
<footer class="article-footer">
  <p><a href="https://ajkernews.in/">HOME</a></p>
</footer>
<div id="artCommentModal">
  <div class="modal-box">
    <div class="modal-header">
      <h3>মন্তব্য</h3>
      <button type="button" class="modal-close" id="artModalClose">&times;</button>
    </div>
    <div class="modal-form">
      <input type="text" id="artCommentAuthor" placeholder="আপনার নাম (ঐচ্ছিক)">
      <textarea id="artCommentText" placeholder="আপনার মন্তব্য লিখুন..."></textarea>
      <button type="button" id="artCommentSubmit">পাঠান</button>
    </div>
    <div class="modal-list" id="artCommentsList"></div>
  </div>
</div>
<script>
(function() {
  var API_BASE = "https://ajkernews.in";
  var NEWS_ID = ${JSON.stringify(safeId)};
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
  function isLoved() { try { return localStorage.getItem(LOVED_KEY) === '1'; } catch (e) { return false; } }
  function setLoved(v) { try { if (v) localStorage.setItem(LOVED_KEY, '1'); else localStorage.removeItem(LOVED_KEY); } catch (e) {} }
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

  try {
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('from') === 'push') {
      fetch(API_BASE + '/api/push-click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newsId: NEWS_ID, deviceId: getDeviceId(), source: 'notification' })
      }).catch(function() {});
    }
  } catch (e) {}

  // SHARE BUTTON
  var shareBtn = document.getElementById('artShareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', async function(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      var shareUrl = API_BASE + '/news/' + encodeURIComponent(NEWS_ID);
      var headline = document.querySelector('.article-h1');
      var headlineText = headline ? headline.textContent.trim() : 'খবর';
      var bodyEl = document.getElementById('articleBody');
      var fullSummary = bodyEl ? bodyEl.textContent.trim() : '';
      var shortSummary = fullSummary.slice(0, 100).trim();
      var summaryPart = shortSummary ? shortSummary + (fullSummary.length > 100 ? '...' : '') + '\\n\\n' : '';

      if (navigator.share) {
        try {
          await navigator.share({ title: headlineText, text: headlineText + '\\n\\n' + summaryPart + 'বিস্তারিত পড়ুন', url: shareUrl });
          return;
        } catch (err) { if (err && err.name === 'AbortError') return; }
      }

      var text = headlineText + '\\n\\n' + summaryPart + 'বিস্তারিত পড়ুন: ' + shareUrl;
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
      } catch (err) { prompt('লিংক কপি করুন:', text); }
    });
  }

  // LOVE BUTTON
  var loveBtn = document.getElementById('artLoveBtn');
  if (loveBtn) {
    loveBtn.addEventListener('click', async function(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
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

  // COMMENT BUTTON
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

  if (commentBtn) {
    commentBtn.addEventListener('click', function(e) { 
      e.preventDefault(); 
      e.stopPropagation();
      e.stopImmediatePropagation();
      openComments(); 
    });
  }
  if (modalClose) modalClose.addEventListener('click', closeComments);
  if (commentModal) {
    commentModal.addEventListener('click', function(e) { if (e.target === commentModal) closeComments(); });
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
      e.stopPropagation();
      e.stopImmediatePropagation();
      var authorEl = document.getElementById('artCommentAuthor');
      var textEl = document.getElementById('artCommentText');
      var author = (authorEl && authorEl.value || '').trim() || 'Guest';
      var text = (textEl && textEl.value || '').trim();
      if (!text) { alert('মন্তব্য লিখুন!'); return; }
      commentSubmit.disabled = true;
      commentSubmit.textContent = 'পাঠানো হচ্ছে...';
      try {
        var res = await fetch(API_BASE + '/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newsId: NEWS_ID, author: author, text: text, deviceId: getDeviceId() })
        });
        var data = await res.json();
        if (data.success) {
          if (textEl) textEl.value = '';
          await loadComments();
        } else if (data.code === 'ALREADY_COMMENTED') {
          alert('⚠️ আপনি ইতিমধ্যে এই খবরে একটি মন্তব্য করেছেন।');
        } else {
          alert('❌ ' + (data.error || 'মন্তব্য পাঠানো যায়নি'));
        }
      } catch (e) { alert('মন্তব্য পাঠানো যায়নি'); }
      finally { commentSubmit.disabled = false; commentSubmit.textContent = 'পাঠান'; }
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
      "Cache-Control": cacheControl,
      "X-Robots-Tag": "index, follow, max-image-preview:large"
    }
  });
}

async function serveSharePage(id, env, requestUserAgentFromContext = "", requestUrl = null) {
  const safeId = String(id || "").trim();
  if (!safeId) return Response.redirect("https://ajkernews.in/", 302);

  const result = await env.DB.prepare(
    `SELECT id, headline, summary, main_topic, image_url, published_at, created_at, source_name, source_url, category FROM news WHERE id = ? AND status = 'published' LIMIT 1`
  ).bind(safeId).first();

  if (!result) {
    let relatedNews = [];
    try {
      const related = await env.DB.prepare(
        `SELECT id, headline FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT 5`
      ).all();
      relatedNews = related?.results || [];
    } catch (e) {}
    return gonePage(relatedNews);
  }

  const userAgent = requestUserAgentFromContext || "";
  const isBot = BOT_REGEX.test(userAgent);
  const adScripts = isBot ? "" : getAdsterraScripts();
  const adultBlocker = isBot ? "" : getAdultBlockerScript();
  const socialBarScript = isBot ? "" : getSocialBarTopScript();

  const title = cleanText(result.headline) || "Ajker News";
  const description = cleanText(result.summary || "").slice(0, 160);
  const fullSummary = cleanText(result.summary || result.main_topic || "");
  const image = result.image_url || "https://ajkernews.in/logo.png";
  const canonical = `https://ajkernews.in/news/${encodeURIComponent(safeId)}`;
  const category = result.category || "general";

  const catLabel = {
    top:'সেরা খবর', trending:'ট্রেন্ডিং', west_bengal:'পশ্চিমবঙ্গ',
    kolkata:'কলকাতা', india:'ভারত', world:'বিশ্ব', business:'ব্যবসা',
    sports:'খেলা', politics:'রাজনীতি', technology:'প্রযুক্তি',
    entertainment:'বিনোদন', crime:'অপরাধ', district:'জেলা', general:'সাধারণ'
  };

  const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} - Ajker News</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" type="image/x-icon" href="/public/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="/public/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/public/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/public/apple-touch-icon.png">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Ajker News">
<meta name="twitter:card" content="summary_large_image">
${adScripts}
${socialBarScript}
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family: Inter, -apple-system, sans-serif; }
  body { background: #f5f5f5; color: #111; padding: 0 0 40px; }
  .header { background: #fff; padding: 14px 16px; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; gap: 10px; }
  .header img { height: 28px; }
  .header h1 { font-size: 20px; font-weight: 700; }
  .container { max-width: 820px; margin: 0 auto; padding: 16px; }
  .article-card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .article-img { width: 100%; height: auto; display: block; }
  .article-body { padding: 18px 20px 22px; }
  .article-cat { display: inline-block; font-size: 12px; color: #f44336; font-weight: 700; margin-bottom: 8px; text-decoration: none; }
  .article-h1 { font-size: 24px; line-height: 1.4; margin: 0 0 14px; color: #111; font-weight: 700; }
  .article-text { font-size: 17px; line-height: 1.85; color: #222; margin-bottom: 18px; }
  .article-source { font-size: 14px; color: #888; padding-top: 14px; border-top: 1px solid #eee; }
  .article-source a { color: #007bff; text-decoration: none; }
  .cta { display: block; width: 100%; text-align: center; padding: 14px; background: #000; color: #fff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px; margin-top: 18px; }
  .share-comments-section { background: #fff; border-radius: 12px; padding: 20px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .share-comments-title { font-size: 18px; font-weight: 700; margin-bottom: 14px; color: #111; }
  .share-comment-form { margin-bottom: 18px; padding-bottom: 18px; border-bottom: 1px solid #eee; }
  .share-input, .share-textarea { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 10px; font-size: 15px; font-family: inherit; outline: none; }
  .share-textarea { height: 80px; resize: vertical; }
  .share-btn { background: #000; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 15px; }
  .share-comments-list { max-height: 400px; overflow-y: auto; }
</style>
</head>
<body>
${adultBlocker}
<div class="header">
  <img src="https://ajkernews.in/logo.png" alt="Ajker News">
  <h1>Ajker News</h1>
</div>
<div class="container">
  <article class="article-card">
    <img class="article-img" src="${escapeHtml(image)}" alt="${escapeHtml(title)}">
    <div class="article-body">
      <a class="article-cat" href="https://ajkernews.in/?category=${encodeURIComponent(category)}">${escapeHtml(catLabel[category] || category)}</a>
      <h1 class="article-h1">${escapeHtml(title)}</h1>
      <div class="article-text">${escapeHtml(fullSummary)}</div>
      <div class="article-source">
        সূত্র: <a href="${escapeHtml(result.source_url || '#')}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(result.source_name || 'Ajker News')}</a>
      </div>
      <a class="cta" href="${escapeHtml(canonical)}">পূর্ণ খবর পড়ুন →</a>
    </div>
  </article>
  <div class="share-comments-section">
    <h3 class="share-comments-title">মন্তব্য</h3>
    <div class="share-comment-form">
      <input type="text" id="shareAuthor" placeholder="আপনার নাম (ঐচ্ছিক)" class="share-input">
      <textarea id="shareText" placeholder="আপনার মন্তব্য লিখুন..." class="share-textarea"></textarea>
      <button type="button" id="shareSubmit" class="share-btn">পাঠান</button>
    </div>
    <div class="share-comments-list" id="shareCommentsList">
      <p style="color:#888;text-align:center;padding:12px;">লোড হচ্ছে...</p>
    </div>
  </div>
</div>
<script>
(function() {
  var API_BASE = "https://ajkernews.in";
  var NEWS_ID = ${JSON.stringify(safeId)};

  function escapeHtml(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  async function loadComments() {
    var list = document.getElementById('shareCommentsList');
    if (!list) return;
    list.innerHTML = '<p style="color:#888;text-align:center;padding:12px;">লোড হচ্ছে...</p>';
    try {
      var res = await fetch(API_BASE + '/api/comments?id=' + encodeURIComponent(NEWS_ID));
      var data = await res.json();
      var comments = (data && data.comments) || [];
      if (!comments.length) {
        list.innerHTML = '<p style="color:#888;text-align:center;padding:12px;">এখনো কোনো মন্তব্য নেই।</p>';
        return;
      }
      list.innerHTML = comments.map(function(c) {
        return '<div style="border-bottom:1px solid #f0f0f0;padding:10px 0;"><strong style="font-size:14px;">' + escapeHtml(c.author_name) + '</strong><p style="margin:5px 0 0;font-size:14px;color:#444;">' + escapeHtml(c.comment_text) + '</p></div>';
      }).join('');
    } catch (e) {
      list.innerHTML = '<p style="color:#888;text-align:center;padding:12px;">মন্তব্য লোড করা যায়নি।</p>';
    }
  }

  var submitBtn = document.getElementById('shareSubmit');
  if (submitBtn) {
    submitBtn.addEventListener('click', async function() {
      var authorEl = document.getElementById('shareAuthor');
      var textEl = document.getElementById('shareText');
      var author = (authorEl && authorEl.value || '').trim() || 'Guest';
      var text = (textEl && textEl.value || '').trim();
      if (!text) { alert('মন্তব্য লিখুন!'); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = 'পাঠানো হচ্ছে...';
      try {
        var res = await fetch(API_BASE + '/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newsId: NEWS_ID, author: author, text: text })
        });
        if (res.ok) { if (textEl) textEl.value = ''; await loadComments(); }
        else { alert('মন্তব্য পাঠানো যায়নি'); }
      } catch (e) { alert('মন্তব্য পাঠানো যায়নি'); }
      finally { submitBtn.disabled = false; submitBtn.textContent = 'পাঠান'; }
    });
  }

  loadComments();
})();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}

async function handlePushClick(request, env) {
  try {
    const body = await request.json();
    const { newsId, deviceId, source } = body;
    if (!newsId) return json({ success: false, error: "newsId required" }, 400, 0);
    await env.DB.prepare(
      `INSERT INTO push_clicks (id, news_id, device_id, source, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), newsId, deviceId || "anonymous", source || "unknown", new Date().toISOString()).run();
    return json({ success: true }, 200, 0);
  } catch (error) { return json({ success: false, error: "Click tracking failed" }, 500, 0); }
}

async function handlePushStats(env) {
  try {
    const total = await env.DB.prepare(`SELECT COUNT(*) AS total FROM push_clicks`).first();
    const today = await env.DB.prepare(`SELECT COUNT(*) AS total FROM push_clicks WHERE created_at >= datetime('now', '-1 day')`).first();
    const last7days = await env.DB.prepare(`SELECT COUNT(*) AS total FROM push_clicks WHERE created_at >= datetime('now', '-7 days')`).first();
    const topNews = await env.DB.prepare(`SELECT news_id, COUNT(*) AS clicks FROM push_clicks GROUP BY news_id ORDER BY clicks DESC LIMIT 10`).all();
    return json({
      success: true,
      total: Number(total?.total || 0),
      today: Number(today?.total || 0),
      last7days: Number(last7days?.total || 0),
      topNews: topNews.results || []
    }, 200, 0);
  } catch (error) { return json({ success: false, error: error.message }, 500, 0); }
}

async function handlePushLogs(env, url) {
  try {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
    const status = url.searchParams.get("status") || null;
    let query = `SELECT id, news_id, token, status, error, title, sent_at FROM push_log`;
    const binds = [];
    if (status) { query += ` WHERE status = ?`; binds.push(status); }
    query += ` ORDER BY sent_at DESC LIMIT ?`;
    binds.push(limit);
    const result = await env.DB.prepare(query).bind(...binds).all();
    const totalSent = await env.DB.prepare(`SELECT COUNT(*) AS c FROM push_log WHERE status = 'sent'`).first();
    const totalFailed = await env.DB.prepare(`SELECT COUNT(*) AS c FROM push_log WHERE status = 'failed'`).first();
    return json({
      success: true,
      totalSent: Number(totalSent?.c || 0),
      totalFailed: Number(totalFailed?.c || 0),
      logs: result.results || []
    }, 200, 0);
  } catch (error) { return json({ success: false, error: error.message }, 500, 0); }
}

async function handleGetNews(url, env, request) {
  return cacheNewsApi(request, async () => await handleGetNewsInternal(url, env), API_CACHE_TTL);
}

async function handleGetNewsInternal(url, env) {
  const category = url.searchParams.get("category") || "top";
  const query = (url.searchParams.get("q") || "").trim();
  const specificId = url.searchParams.get("id");
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const requestedLimit = parseInt(url.searchParams.get("limit") || "10", 10);
  const limit = Math.min(Math.max(requestedLimit, 1), 20);

  const selectFields = `news.id, news.headline, news.summary, news.main_topic, news.category, news.image_url, news.published_at, news.source_name, news.source_url, news.created_at, news.score, COUNT(nl.id) AS love_count`;

  if (specificId) {
    const result = await env.DB.prepare(
      `SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id 
       WHERE news.id = ? AND news.status = 'published' 
       GROUP BY news.id LIMIT 1`
    ).bind(specificId).all();
    return json({ success: true, count: (result.results || []).length, news: result.results || [] }, 200, 0);
  }

  if (query) {
    const transliterated = toTransliterated(query);
    const result = await env.DB.prepare(
      `SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id 
       WHERE news.status = 'published' 
         AND (news.search_text LIKE ? OR news.headline LIKE ? OR news.summary LIKE ? OR news.main_topic LIKE ?) 
       GROUP BY news.id 
       ORDER BY news.created_at DESC, news.published_at DESC 
       LIMIT ? OFFSET ?`
    ).bind(`%${transliterated}%`, `%${query}%`, `%${query}%`, `%${query}%`, limit + 1, offset).all();
    const rawNews = result?.results || [];
    const hasMore = rawNews.length > limit;
    const news = rawNews.slice(0, limit);
    return json({ success: true, count: news.length, offset, limit, has_more: hasMore, news }, 200, 0);
  }

  if (category === "top") {
    const windows = [
      { sql: "datetime('now', '-24 hours')" },
      { sql: "datetime('now', '-48 hours')" },
      { sql: "datetime('now', '-7 days')" },
      { sql: null }
    ];
    for (const win of windows) {
      const whereClause = win.sql 
        ? `news.status = 'published' AND news.created_at >= ${win.sql}`
        : `news.status = 'published'`;
      const result = await env.DB.prepare(
        `SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id 
         WHERE ${whereClause}
         GROUP BY news.id 
         ORDER BY news.created_at DESC, news.score DESC 
         LIMIT ? OFFSET ?`
      ).bind(limit + 1, offset).all();
      const rawNews = result?.results || [];
      if (rawNews.length > 0) {
        const hasMore = rawNews.length > limit;
        const news = rawNews.slice(0, limit);
        return json({ success: true, count: news.length, offset, limit, has_more: hasMore, news }, 200, 0);
      }
    }
  }

  if (category === "trending") {
    const windows = [
      { sql: "datetime('now', '-3 days')" },
      { sql: "datetime('now', '-7 days')" },
      { sql: "datetime('now', '-30 days')" },
      { sql: null }
    ];
    for (const win of windows) {
      const whereClause = win.sql 
        ? `news.status = 'published' AND news.created_at >= ${win.sql}`
        : `news.status = 'published'`;
      const result = await env.DB.prepare(
        `SELECT 
           ${selectFields},
           (COUNT(DISTINCT nl.id) * 5) AS love_score,
           (SELECT COUNT(*) FROM news_comments nc WHERE nc.news_id = news.id) AS comment_count,
           (SELECT COUNT(*) FROM push_clicks pc WHERE pc.news_id = news.id) AS click_count
         FROM news 
         LEFT JOIN news_loves nl ON nl.news_id = news.id 
         WHERE ${whereClause}
         GROUP BY news.id 
         ORDER BY (
           (COUNT(DISTINCT nl.id) * 5) +
           ((SELECT COUNT(*) FROM news_comments nc WHERE nc.news_id = news.id) * 4) +
           ((SELECT COUNT(*) FROM push_clicks pc WHERE pc.news_id = news.id) * 3) +
           (news.score * 1) +
           CASE 
             WHEN (julianday('now') - julianday(news.created_at)) * 24 < 6 THEN 20
             WHEN (julianday('now') - julianday(news.created_at)) * 24 < 12 THEN 15
             WHEN (julianday('now') - julianday(news.created_at)) * 24 < 24 THEN 10
             WHEN (julianday('now') - julianday(news.created_at)) * 24 < 48 THEN 5
             WHEN (julianday('now') - julianday(news.created_at)) * 24 < 72 THEN 2
             ELSE 0
           END
         ) DESC 
         LIMIT ? OFFSET ?`
      ).bind(limit + 1, offset).all();
      const rawNews = result?.results || [];
      if (rawNews.length > 0) {
        const hasMore = rawNews.length > limit;
        const news = rawNews.slice(0, limit);
        return json({ success: true, count: news.length, offset, limit, has_more: hasMore, news }, 200, 0);
      }
    }
  }

  if (category === "all") {
    const result = await env.DB.prepare(
      `SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id 
       WHERE news.status = 'published' 
       GROUP BY news.id 
       ORDER BY news.created_at DESC, news.published_at DESC 
       LIMIT ? OFFSET ?`
    ).bind(limit + 1, offset).all();
    const rawNews = result?.results || [];
    const hasMore = rawNews.length > limit;
    const news = rawNews.slice(0, limit);
    return json({ success: true, count: news.length, offset, limit, has_more: hasMore, news }, 200, 0);
  }

  const result = await env.DB.prepare(
    `SELECT ${selectFields} FROM news LEFT JOIN news_loves nl ON nl.news_id = news.id 
     WHERE news.status = 'published' AND news.category = ? 
     GROUP BY news.id 
     ORDER BY news.created_at DESC, news.published_at DESC 
     LIMIT ? OFFSET ?`
  ).bind(category, limit + 1, offset).all();
  const rawNews = result?.results || [];
  const hasMore = rawNews.length > limit;
  const news = rawNews.slice(0, limit);
  return json({ success: true, count: news.length, offset, limit, has_more: hasMore, news }, 200, 0);
}

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
      await env.DB.prepare(`UPDATE push_subscriptions SET token = ?, keys_json = ?, created_at = ? WHERE id = ?`).bind(token, keys, now, existing.id).run();
      return json({ success: true, message: "Updated" }, 200, 0);
    }
    await env.DB.prepare(`INSERT INTO push_subscriptions (id, endpoint, keys_json, token, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), endpoint, keys, token, now).run();
    return json({ success: true }, 200, 0);
  } catch (error) { return json({ success: false, error: "Subscribe error" }, 500, 0); }
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
  } catch (error) { return json({ success: false, error: "Unsubscribe error" }, 500, 0); }
}

async function handlePushSync(request, env) {
  return json({ success: true, synced: true }, 200, 0);
}

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
  } catch (error) { return json({ success: false, error: error?.message || "Love error" }, 500, 0); }
}

async function getComments(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400, 0);
  const result = await env.DB.prepare(`SELECT id, author_name, comment_text, created_at FROM news_comments WHERE news_id = ? ORDER BY created_at ASC`).bind(id).all();
  return json({ comments: result.results || [] }, 200, 0);
}

async function addComment(request, env) {
  try {
    const { newsId, author, text, deviceId } = await request.json();
    
    if (!newsId || !text) {
      return json({ success: false, error: "Missing fields" }, 400, 0);
    }
    if (!deviceId) {
      return json({ success: false, error: "Device ID required" }, 400, 0);
    }
    
    if (isSpamComment(text)) {
      return json({ success: false, error: "স্প্যাম বা অশ্লীল মন্তব্য গ্রহণ করা হয় না।" }, 400, 0);
    }
    if (author && isSpamComment(author)) {
      return json({ success: false, error: "নামে স্প্যাম শনাক্ত হয়েছে।" }, 400, 0);
    }
    
    const alreadyCommented = await hasUserCommented(env, newsId, deviceId);
    if (alreadyCommented) {
      return json({ 
        success: false, 
        error: "আপনি ইতিমধ্যে এই খবরে একটি মন্তব্য করেছেন।",
        code: "ALREADY_COMMENTED"
      }, 409, 0);
    }
    
    try {
      const recent = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM news_comments 
         WHERE device_id = ? AND created_at >= datetime('now', '-60 seconds')`
      ).bind(deviceId).first();
      if (Number(recent?.c || 0) >= 1) {
        return json({ success: false, error: "অনুগ্রহ করে ৬০ সেকেন্ড পরে চেষ্টা করুন।" }, 429, 0);
      }
    } catch (e) {}
    
    const id = crypto.randomUUID();
    const cleanAuthor = cleanText(author || "Guest").slice(0, 50);
    const cleanComment = cleanText(text).slice(0, 1000);
    
    await env.DB.prepare(
      `INSERT INTO news_comments (id, news_id, author_name, comment_text, device_id, created_at) 
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, newsId, cleanAuthor, cleanComment, deviceId, new Date().toISOString()).run();
    
    return json({ success: true, comment_id: id }, 200, 0);
  } catch (error) { 
    return json({ success: false, error: error?.message || "Comment error" }, 500, 0); 
  }
}

async function generateSitemap(env) {
  try {
    const result = await env.DB.prepare(`SELECT id, published_at, created_at FROM news WHERE status = 'published' ORDER BY created_at DESC LIMIT 5000`).all();
    const news = result.results || [];
    const baseUrl = "https://ajkernews.in";
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`;
    for (const item of news) {
      const displayDate = item.created_at || item.published_at;
      const lastmod = displayDate ? new Date(displayDate).toISOString() : new Date().toISOString();
      xml += `\n  <url><loc>${baseUrl}/news/${encodeURIComponent(item.id)}</loc><lastmod>${lastmod}</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>`;
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
    const result = await env.DB.prepare(`SELECT id, headline, summary, main_topic, category, published_at, created_at FROM news WHERE status = 'published' AND created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 5000`).all();
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

function generateRobotsTxt(env) {
  const indexNowLine = (env && env.INDEXNOW_KEY)
    ? `# IndexNow\nIndexNow: https://ajkernews.in/${env.INDEXNOW_KEY}.txt\n\n`
    : "";
  const text = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /admin/
Disallow: /api/admin/
Disallow: /api/admin
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

${indexNowLine}Sitemap: https://ajkernews.in/sitemap.xml
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
  <title>Ajker News</title>
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

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Accept, Origin, User-Agent",
    "access-control-max-age": "86400"
  };
}

function json(data, status = 200, cacheSeconds = 60) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=UTF-8",
      "cache-control": `no-cache, no-store, must-revalidate, max-age=0`,
      "pragma": "no-cache",
      "expires": "0"
    }
  });
}

function getAdminLoginHTML() {
  return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Login - Ajker News</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" type="image/x-icon" href="/public/favicon.ico">
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family: Inter, -apple-system, sans-serif; }
  body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .box { background: #fff; border-radius: 20px; padding: 40px 32px; max-width: 400px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; }
  h1 { font-size: 26px; margin-bottom: 8px; color: #111; }
  p { font-size: 14px; color: #666; margin-bottom: 28px; }
  input { width: 100%; padding: 14px 16px; border: 2px solid #e5e5e5; border-radius: 12px; font-size: 15px; outline: none; margin-bottom: 14px; }
  input:focus { border-color: #667eea; }
  button { width: 100%; padding: 14px; background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; border: none; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; }
  button:active { transform: scale(0.98); }
  .error { color: #c62828; font-size: 13px; margin-top: 12px; min-height: 18px; }
</style>
</head>
<body>
<div class="box">
  <h1>🔐 Admin Login</h1>
  <p>Ajker News Content Manager</p>
  <input type="password" id="password" placeholder="Password" onkeypress="if(event.key==='Enter') login()">
  <button onclick="login()">Login</button>
  <div class="error" id="error"></div>
</div>
<script>
async function login() {
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  if (!password) { errorEl.textContent = 'পাসওয়ার্ড দিন'; return; }
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.success) window.location.href = '/admin/dashboard';
    else errorEl.textContent = data.error || 'ভুল পাসওয়ার্ড';
  } catch (e) { errorEl.textContent = 'Network error'; }
}
</script>
</body>
</html>`;
}

function getAdminDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Dashboard - Ajker News</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" type="image/x-icon" href="/public/favicon.ico">
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family: Inter, -apple-system, sans-serif; }
  body { background: #f0f2f5; color: #111; min-height: 100vh; }
  .header { background: #fff; padding: 16px 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
  .header h1 { font-size: 20px; }
  .header button { padding: 9px 16px; background: #ffebee; color: #c62828; border: none; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; }
  .container { max-width: 1000px; margin: 0 auto; padding: 16px; }
  .search { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .search input { flex: 1; min-width: 200px; padding: 12px 16px; border: 1px solid #ddd; border-radius: 10px; font-size: 14px; outline: none; }
  .search input:focus { border-color: #111; }
  .search button { padding: 12px 24px; background: #111; color: #fff; border: none; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; }
  .search button.reset { background: #f2f2f2; color: #333; }
  .news-item { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); display: flex; gap: 14px; margin-bottom: 12px; }
  .news-item img { width: 100px; height: 70px; object-fit: cover; border-radius: 8px; background: #f0f0f0; flex-shrink: 0; }
  .news-item .content { flex: 1; min-width: 0; }
  .news-item h3 { font-size: 15px; font-weight: 700; margin-bottom: 6px; line-height: 1.4; }
  .news-item .meta { font-size: 12px; color: #888; margin-bottom: 10px; }
  .news-item .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .news-item .actions button { padding: 7px 14px; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; }
  .btn-edit { background: #e3f2fd; color: #1976d2; }
  .btn-hide { background: #f5f5f5; color: #666; }
  .btn-comments { background: #fff3e0; color: #e65100; }
  .btn-back { background: #e8f5e9; color: #2e7d32; padding: 10px 20px; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; margin-bottom: 16px; }
  .load-more-btn { padding: 14px 32px; background: #111; color: #fff; border: none; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; }
  .comment-item { background: #fff; border-radius: 12px; padding: 14px 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; }
  .comment-item .info { flex: 1; min-width: 0; }
  .comment-item .author { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
  .comment-item .text { font-size: 13px; color: #555; margin-bottom: 4px; }
  .comment-item .meta { font-size: 11px; color: #999; margin-top: 4px; }
  .comment-item .actions { display: flex; gap: 6px; flex-shrink: 0; }
  .comment-item .btn-edit { padding: 8px 12px; background: #e3f2fd; color: #1976d2; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; }
  .comment-item .btn-delete { padding: 8px 12px; background: #ffebee; color: #c62828; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; }
  .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 2000; align-items: center; justify-content: center; padding: 16px; }
  .modal.active { display: flex; }
  .modal-box { background: #fff; border-radius: 16px; padding: 24px; max-width: 520px; width: 100%; max-height: 90vh; overflow-y: auto; }
  .modal-box h2 { font-size: 18px; margin-bottom: 16px; }
  .modal-box label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px; color: #555; margin-top: 12px; }
  .modal-box textarea, .modal-box input { width: 100%; padding: 10px 12px; border: 1.5px solid #ddd; border-radius: 8px; font-size: 14px; outline: none; font-family: inherit; }
  .modal-box textarea { height: 100px; resize: vertical; }
  .modal-actions { display: flex; gap: 10px; margin-top: 20px; }
  .modal-actions button { flex: 1; padding: 12px; border: none; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; }
  .btn-save { background: #111; color: #fff; }
  .btn-cancel { background: #f2f2f2; color: #333; }
  .toast { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); background: #111; color: #fff; padding: 12px 20px; border-radius: 10px; font-size: 14px; font-weight: 600; opacity: 0; pointer-events: none; transition: opacity 0.3s; z-index: 3000; }
  .toast.show { opacity: 1; }
  .toast.success { background: #2e7d32; }
  .toast.error { background: #c62828; }
  .empty { text-align: center; padding: 40px; color: #888; }
</style>
</head>
<body>
<div class="header">
  <h1 id="pageTitle">📰 Admin Panel</h1>
  <button onclick="logout()">🚪 Logout</button>
</div>
<div class="container">
  <div class="search">
    <input type="text" id="searchInput" placeholder="🔍 Headline বা 32-char ID দিয়ে খুঁজুন..." onkeypress="if(event.key==='Enter') searchNow()">
    <button onclick="searchNow()">Search</button>
    <button class="reset" onclick="resetSearch()">Reset</button>
  </div>
  <div id="newsList"><div class="empty">Loading...</div></div>
</div>

<div id="editModal" class="modal">
  <div class="modal-box">
    <h2>✏️ Edit News</h2>
    <input type="hidden" id="editId">
    <label>Headline</label>
    <textarea id="editHeadline"></textarea>
    <label>Summary</label>
    <textarea id="editSummary"></textarea>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeEdit()">Cancel</button>
      <button class="btn-save" onclick="saveEdit()">Save</button>
    </div>
  </div>
</div>

<div id="editCommentModal" class="modal">
  <div class="modal-box">
    <h2>✏️ Edit Comment</h2>
    <input type="hidden" id="editCommentId">
    <label>Author</label>
    <input type="text" id="editCommentAuthor">
    <label>Comment</label>
    <textarea id="editCommentText"></textarea>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeEditComment()">Cancel</button>
      <button class="btn-save" onclick="saveEditComment()">Save</button>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
let currentMode = 'list';
let currentNewsId = '';
let currentSearch = '';
let currentOffset = 0;
const PAGE_SIZE = 100;
let allLoadedNews = [];
let totalNews = 0;

function toast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  setTimeout(() => t.className = 'toast ' + (type || ''), 2500);
}

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function isHexId(s) { return /^[a-f0-9]{32}$/i.test(s); }

async function loadNews(search, append) {
  currentMode = 'list';
  currentNewsId = '';
  currentSearch = search || '';
  document.getElementById('pageTitle').textContent = '📰 Admin Panel';
  if (!append) { currentOffset = 0; allLoadedNews = []; }
  const list = document.getElementById('newsList');
  if (!append) list.innerHTML = '<div class="empty">Loading...</div>';
  try {
    let url = '/api/admin/list?limit=' + PAGE_SIZE + '&offset=' + currentOffset;
    if (search) {
      if (isHexId(search)) url += '&id=' + encodeURIComponent(search);
      else url += '&search=' + encodeURIComponent(search);
    }
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/admin'; return; }
    const data = await res.json();
    const news = data.news || [];
    totalNews = data.total || 0;
    if (!news.length && !append) { list.innerHTML = '<div class="empty">No news found for "' + esc(search || '') + '"</div>'; return; }
    if (!append) allLoadedNews = news;
    else allLoadedNews = allLoadedNews.concat(news);

    let html = allLoadedNews.map(n => \`
      <div class="news-item">
        <img src="\${esc(n.image_url || '/logo.png')}" onerror="this.src='/logo.png'" alt="">
        <div class="content">
          <h3>\${esc(n.headline || 'Untitled')}</h3>
          <div class="meta">ID: <code style="background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:11px;">\${esc(n.id || '')}</code></div>
          <div class="meta">\${esc(n.category || 'general')} • \${esc((n.created_at||'').slice(0,16).replace('T',' '))}</div>
          <div class="actions">
            <button class="btn-edit" onclick='openEdit(\${JSON.stringify(n).replace(/'/g,"&#39;")})'>✏️ Edit</button>
            <button class="btn-hide" onclick="hideNews('\${n.id}')">🙈 Hide</button>
            <button class="btn-comments" onclick="showComments('\${n.id}', '\${esc(n.headline).replace(/'/g,"&#39;")}')">💬 Comments</button>
          </div>
        </div>
      </div>\`).join('');

    if (!isHexId(search) && allLoadedNews.length < totalNews) {
      html += \`
        <div style="text-align:center;padding:24px 0;">
          <button class="load-more-btn" onclick="loadMore()">আরও দেখুন (\${allLoadedNews.length} / \${totalNews})</button>
        </div>\`;
    } else if (!isHexId(search) && allLoadedNews.length > 0 && totalNews > 0) {
      html += \`<div style="text-align:center;padding:20px;color:#888;font-size:13px;">✅ সব \${totalNews}টি Post দেখানো হয়েছে</div>\`;
    }
    list.innerHTML = html;
  } catch (e) { list.innerHTML = '<div class="empty">Network error</div>'; }
}

function loadMore() { currentOffset += PAGE_SIZE; loadNews(currentSearch, true); }
function searchNow() { const q = document.getElementById('searchInput').value.trim(); loadNews(q, false); }
function resetSearch() {
  document.getElementById('searchInput').value = '';
  currentOffset = 0; allLoadedNews = []; totalNews = 0; currentNewsId = ''; currentMode = 'list';
  loadNews('', false);
}

async function showComments(newsId, headline) {
  currentMode = 'comments';
  currentNewsId = newsId;
  document.getElementById('pageTitle').textContent = '💬 Comments';
  const list = document.getElementById('newsList');
  list.innerHTML = '<div class="empty">Loading comments...</div>';
  try {
    const res = await fetch('/api/admin/comments?newsId=' + encodeURIComponent(newsId), { credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/admin'; return; }
    const data = await res.json();
    const comments = data.comments || [];
    let html = \`<div style="margin-bottom:16px;"><button class="btn-back" onclick="goBackToNewsList()">← Back to News List</button><p style="font-size:13px;color:#888;margin-top:8px;">News: \${esc((headline || '').slice(0, 80))}</p></div>\`;
    if (!comments.length) html += '<div class="empty">No comments found</div>';
    else {
      html += comments.map(c => \`
        <div class="comment-item">
          <div class="info">
            <div class="author">👤 \${esc(c.author_name || 'Guest')}</div>
            <div class="text">\${esc(c.comment_text || '')}</div>
            <div class="meta">\${esc((c.created_at||'').slice(0,16).replace('T',' '))}</div>
          </div>
          <div class="actions">
            <button class="btn-edit" onclick='openEditComment(\${JSON.stringify(c).replace(/'/g,"&#39;")})'>✏️ Edit</button>
            <button class="btn-delete" onclick="deleteComment('\${c.id}', '\${newsId}')">🗑️ Delete</button>
          </div>
        </div>\`).join('');
    }
    list.innerHTML = html;
  } catch (e) { list.innerHTML = '<div class="empty">Network error</div>'; }
}

function goBackToNewsList() { currentMode = 'list'; currentNewsId = ''; currentOffset = 0; allLoadedNews = []; totalNews = 0; loadNews(currentSearch, false); }

function openEdit(n) {
  document.getElementById('editId').value = n.id || '';
  document.getElementById('editHeadline').value = n.headline || '';
  document.getElementById('editSummary').value = n.summary || '';
  document.getElementById('editModal').classList.add('active');
}
function closeEdit() { document.getElementById('editModal').classList.remove('active'); }

async function saveEdit() {
  const id = document.getElementById('editId').value;
  const updates = { headline: document.getElementById('editHeadline').value.trim(), summary: document.getElementById('editSummary').value.trim() };
  try {
    const res = await fetch('/api/admin/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id, updates }) });
    const data = await res.json();
    if (data.success) { toast('✅ Updated', 'success'); closeEdit(); if (currentMode === 'comments') showComments(currentNewsId, document.getElementById('pageTitle').textContent); else loadNews(currentSearch, false); }
    else toast('❌ ' + (data.error || 'Failed'), 'error');
  } catch (e) { toast('❌ Network error', 'error'); }
}

async function hideNews(id) {
  if (!confirm('Hide this news?')) return;
  try {
    const res = await fetch('/api/admin/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id, updates: { status: 'rejected' } }) });
    const data = await res.json();
    if (data.success) { toast('🙈 Hidden', 'success'); loadNews(currentSearch, false); }
    else toast('❌ ' + (data.error || 'Failed'), 'error');
  } catch (e) { toast('❌ Network error', 'error'); }
}

function openEditComment(c) {
  document.getElementById('editCommentId').value = c.id || '';
  document.getElementById('editCommentAuthor').value = c.author_name || '';
  document.getElementById('editCommentText').value = c.comment_text || '';
  document.getElementById('editCommentModal').classList.add('active');
}
function closeEditComment() { document.getElementById('editCommentModal').classList.remove('active'); }

async function saveEditComment() {
  const id = document.getElementById('editCommentId').value;
  const updates = { author_name: document.getElementById('editCommentAuthor').value.trim(), comment_text: document.getElementById('editCommentText').value.trim() };
  try {
    const res = await fetch('/api/admin/comment-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id, updates }) });
    const data = await res.json();
    if (data.success) { toast('✅ Comment updated', 'success'); closeEditComment(); showComments(currentNewsId, document.getElementById('pageTitle').textContent); }
    else toast('❌ ' + (data.error || 'Failed'), 'error');
  } catch (e) { toast('❌ Network error', 'error'); }
}

async function deleteComment(id, newsId) {
  if (!confirm('Delete this comment?')) return;
  try {
    const res = await fetch('/api/admin/comment-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id }) });
    const data = await res.json();
    if (data.success) { toast('🗑️ Deleted', 'success'); showComments(newsId, document.getElementById('pageTitle').textContent); }
    else toast('❌ ' + (data.error || 'Failed'), 'error');
  } catch (e) { toast('❌ Network error', 'error'); }
}

async function logout() {
  try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  location.href = '/admin';
}

loadNews('', false);
</script>
</body>
</html>`;
}

async function ensureTables(env) {
  const queries = [
    `CREATE TABLE IF NOT EXISTS news (id TEXT PRIMARY KEY, source_url TEXT UNIQUE, source_name TEXT, source_title TEXT, source_description TEXT, headline TEXT, summary TEXT, main_topic TEXT, category TEXT, language TEXT DEFAULT 'bn', image_url TEXT, published_at TEXT, created_at TEXT, day_key TEXT, status TEXT DEFAULT 'published', score INTEGER DEFAULT 0, search_text TEXT, indexed_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS news_loves (id INTEGER PRIMARY KEY AUTOINCREMENT, news_id TEXT, device_id TEXT, UNIQUE(news_id, device_id))`,
    `CREATE TABLE IF NOT EXISTS news_comments (id TEXT PRIMARY KEY, news_id TEXT, author_name TEXT, comment_text TEXT, device_id TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, endpoint TEXT UNIQUE, keys_json TEXT, token TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS push_clicks (id TEXT PRIMARY KEY, news_id TEXT, device_id TEXT, source TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS push_log (id TEXT PRIMARY KEY, news_id TEXT, token TEXT, status TEXT, error TEXT, title TEXT, sent_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS push_sent (id TEXT PRIMARY KEY, news_id TEXT, token TEXT, sent_at TEXT, UNIQUE(news_id, token))`,
    `CREATE TABLE IF NOT EXISTS push_digest_log (id TEXT PRIMARY KEY, digest_type TEXT, news_count INTEGER, sent_count INTEGER, sent_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS live_events (id TEXT PRIMARY KEY, event_type TEXT, payload TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, token TEXT UNIQUE, ip TEXT, user_agent TEXT, expires_at TEXT, created_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_news_status_published ON news(status, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_status_created ON news(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_category_published ON news(category, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_score_published ON news(score DESC, published_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_loves_news_id ON news_loves(news_id)`,
    `CREATE INDEX IF NOT EXISTS idx_news_comments_news_created ON news_comments(news_id, created_at ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_news_comments_device ON news_comments(news_id, device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_token ON push_subscriptions(token)`,
    `CREATE INDEX IF NOT EXISTS idx_push_clicks_created ON push_clicks(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_push_clicks_news ON push_clicks(news_id)`,
    `CREATE INDEX IF NOT EXISTS idx_push_log_sent_at ON push_log(sent_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_push_log_news_id ON push_log(news_id)`,
    `CREATE INDEX IF NOT EXISTS idx_push_sent_news ON push_sent(news_id)`,
    `CREATE INDEX IF NOT EXISTS idx_push_sent_sent_at ON push_sent(sent_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_push_digest_log_sent_at ON push_digest_log(sent_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_live_events_created_at ON live_events(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token)`
  ];

  for (const sql of queries) {
    try { await env.DB.prepare(sql).run(); } catch (error) {}
  }

  try {
    const columns = await env.DB.prepare(`PRAGMA table_info(news)`).all();
    const colNames = (columns.results || []).map(c => c.name);
    if (!colNames.includes("language")) await env.DB.prepare(`ALTER TABLE news ADD COLUMN language TEXT DEFAULT 'bn'`).run();
    if (!colNames.includes("search_text")) await env.DB.prepare(`ALTER TABLE news ADD COLUMN search_text TEXT`).run();
    if (!colNames.includes("indexed_at")) await env.DB.prepare(`ALTER TABLE news ADD COLUMN indexed_at TEXT`).run();
  } catch (error) {}

  try {
    const pushColumns = await env.DB.prepare(`PRAGMA table_info(push_subscriptions)`).all();
    const pushColNames = (pushColumns.results || []).map(c => c.name);
    if (!pushColNames.includes("token")) await env.DB.prepare(`ALTER TABLE push_subscriptions ADD COLUMN token TEXT`).run();
  } catch (error) {}

  try {
    const commentCols = await env.DB.prepare(`PRAGMA table_info(news_comments)`).all();
    const commentColNames = (commentCols.results || []).map(c => c.name);
    if (!commentColNames.includes("device_id")) {
      await env.DB.prepare(`ALTER TABLE news_comments ADD COLUMN device_id TEXT`).run();
    }
  } catch (error) {}
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
