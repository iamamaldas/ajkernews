/**
 * Ajker News Worker
 * Complete backend
 *
 * Features:
 * - Hourly scheduled news update
 * - GNews Bengali + English sources
 * - Gemini selection / Bengali rewriting
 * - Gemini fallback model + safe fallback without Gemini
 * - D1 storage
 * - 25-news API pagination
 * - "আরও পড়ুন" support via has_more
 * - Push notifications
 * - Share preview
 * - Google indexing
 * - Sitemap
 * - Loves / comments
 * - Affiliate redirect
 */

import webPush from "web-push";
import ANALYTICS_CONFIG from "./config-analytics.js";
import ADS_CONFIG from "./config-ads.js";
import AFFILIATE_CONFIG from "./config-affiliate.js";


/* =========================================================
   CONFIG
   ========================================================= */

const MAX_NEWS = 200;
const MAX_SELECTED_NEWS = 5;

const API_PAGE_SIZE = 25;

const GNEWS_MAX_RESULTS = 10;

/*
 * Primary Gemini model.
 * If it fails, secondary model is tried.
 */
const GEMINI_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite"
];

let tablesReadyPromise = null;


/* =========================================================
   BENGALI TRANSLITERATION
   ========================================================= */

const BN_TO_EN_MAP = {
  "অ": "o",
  "আ": "a",
  "ই": "i",
  "ঈ": "i",
  "উ": "u",
  "ঊ": "u",
  "ঋ": "ri",
  "এ": "e",
  "ঐ": "oi",
  "ও": "o",
  "ঔ": "ou",

  "ক": "k",
  "খ": "kh",
  "গ": "g",
  "ঘ": "gh",
  "ঙ": "ng",

  "চ": "ch",
  "ছ": "chh",
  "জ": "j",
  "ঝ": "jh",
  "ঞ": "n",

  "ট": "t",
  "ঠ": "th",
  "ড": "d",
  "ঢ": "dh",
  "ণ": "n",

  "ত": "t",
  "থ": "th",
  "দ": "d",
  "ধ": "dh",
  "ন": "n",

  "প": "p",
  "ফ": "ph",
  "ব": "b",
  "ভ": "bh",
  "ম": "m",

  "য": "j",
  "র": "r",
  "ল": "l",

  "শ": "sh",
  "ষ": "sh",
  "স": "s",
  "হ": "h",

  "ড়": "r",
  "ঢ়": "rh",
  "য়": "y",

  "ং": "ng",
  "ঃ": "h",
  "ঁ": "n",

  "া": "a",
  "ি": "i",
  "ী": "i",
  "ু": "u",
  "ূ": "u",
  "ৃ": "ri",
  "ে": "e",
  "ৈ": "oi",
  "ো": "o",
  "ৌ": "ou"
};

function toTransliterated(text) {
  if (!text) return "";

  let result = "";

  for (const char of String(text)) {
    result +=
      BN_TO_EN_MAP[char] ||
      char;
  }

  return result
    .toLowerCase()
    .replace(
      /[^a-z0-9 ]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


/* =========================================================
   FETCH HANDLER
   ========================================================= */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(request.url);

    if (
      request.method === "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders()
        }
      );
    }

    try {

      await ensureTablesOnce(
        env
      );


      /* -----------------------------------------
         SEARCH CONSOLE FILE
         ----------------------------------------- */

      if (
        ANALYTICS_CONFIG.searchConsole &&
        url.pathname ===
          ANALYTICS_CONFIG
            .searchConsole
            .filePath
      ) {

        return new Response(
          ANALYTICS_CONFIG
            .searchConsole
            .content,
          {
            status: 200,
            headers: {
              "content-type":
                "text/html; charset=UTF-8"
            }
          }
        );
      }


      /* -----------------------------------------
         ADS.TXT
         ----------------------------------------- */

      if (
        url.pathname ===
        "/ads.txt"
      ) {

        return new Response(
          ADS_CONFIG
            .adsTxtContent,
          {
            status: 200,
            headers: {
              "content-type":
                "text/plain; charset=UTF-8"
            }
          }
        );
      }


      /* -----------------------------------------
         SHARE PAGE
         ----------------------------------------- */

      if (
        url.pathname.startsWith(
          "/go/"
        )
      ) {

        const id =
          url.pathname
            .split("/")[2];

        if (!id) {
          return new Response(
            "Invalid link",
            {
              status: 400
            }
          );
        }

        return await serveSharePage(
          id,
          env
        );
      }


      /* -----------------------------------------
         AFFILIATE
         ----------------------------------------- */

      if (
        url.pathname ===
          "/api/affiliate" &&
        request.method ===
          "GET"
      ) {

        return await handleAffiliate(
          url,
          env
        );
      }


      /* -----------------------------------------
         NORMAL NEWS META PAGE
         ----------------------------------------- */

      if (
        url.pathname ===
          "/news" &&
        url.searchParams.has("id")
      ) {

        return await serveNewsPage(
          url,
          env
        );
      }


      /* -----------------------------------------
         SITEMAP
         ----------------------------------------- */

      if (
        url.pathname ===
        "/sitemap.xml"
      ) {

        return await generateSitemap(
          env
        );
      }


      /* -----------------------------------------
         NEWS API
         ----------------------------------------- */

      if (
        url.pathname ===
        "/api/news"
      ) {

        return await handleGetNews(
          url,
          env
        );
      }


      /* -----------------------------------------
         MANUAL UPDATE
         ----------------------------------------- */

      if (
        url.pathname ===
        "/api/update"
      ) {

        if (
          request.method !==
          "POST"
        ) {

          return json(
            {
              success: false,
              error:
                "POST method required"
            },
            405,
            0
          );
        }

        const result =
          await updateNews(
            env
          );

        return json(
          {
            success: true,
            ...result
          },
          200,
          0
        );
      }


      /* -----------------------------------------
         LOVE
         ----------------------------------------- */

      if (
        url.pathname ===
        "/api/love"
      ) {

        if (
          request.method !==
          "POST"
        ) {

          return json(
            {
              error:
                "POST required"
            },
            405,
            0
          );
        }

        return await toggleLove(
          request,
          env
        );
      }


      /* -----------------------------------------
         COMMENTS
         ----------------------------------------- */

      if (
        url.pathname ===
        "/api/comments"
      ) {

        if (
          request.method ===
          "GET"
        ) {

          return await getComments(
            url,
            env
          );
        }

        if (
          request.method ===
          "POST"
        ) {

          return await addComment(
            request,
            env
          );
        }

        return json(
          {
            error:
              "Method not allowed"
          },
          405,
          0
        );
      }


      /* -----------------------------------------
         PUSH SUBSCRIBE
         ----------------------------------------- */

      if (
        url.pathname ===
          "/api/subscribe" &&
        request.method ===
          "POST"
      ) {

        return await handleSubscribe(
          request,
          env
        );
      }


      /* -----------------------------------------
         HEALTH
         ----------------------------------------- */

      if (
        url.pathname ===
        "/"
      ) {

        return new Response(
          "Ajker News Worker is running.",
          {
            status: 200,
            headers: {
              "content-type":
                "text/plain; charset=UTF-8"
            }
          }
        );
      }


      return new Response(
        "Ajker News Worker is running.",
        {
          status: 200,
          headers: {
            "content-type":
              "text/plain; charset=UTF-8"
          }
        }
      );

    } catch (error) {

      console.error(
        "Worker error:",
        error
      );

      return json(
        {
          success: false,
          error:
            error?.message ||
            "Internal server error"
        },
        500,
        0
      );
    }
  },


  /* =====================================================
     CRON
     ===================================================== */

  async scheduled(
    event,
    env,
    ctx
  ) {

    console.log(
      "Scheduled update started:",
      new Date(
        event.scheduledTime
      ).toISOString()
    );

    try {

      const result =
        await updateNews(
          env
        );

      console.log(
        "Scheduled update completed:",
        JSON.stringify(result)
      );


      /*
       * Push notification is background work.
       */
      if (
        result.stored > 0
      ) {

        ctx.waitUntil(
          sendPushNotifications(
            env,
            "📰 নতুন খবর!",
            `${result.stored}টি নতুন খবর প্রকাশিত হয়েছে।`,
            "https://ajkernews.in/"
          ).catch(
            error => {
              console.error(
                "Scheduled push error:",
                error
              );
            }
          )
        );
      }

    } catch (error) {

      /*
       * IMPORTANT:
       * Do not throw again.
       *
       * This prevents the scheduled execution
       * from becoming an unhandled failure.
       */

      console.error(
        "Scheduled update failed:",
        error
      );
    }
  }
};


/* =========================================================
   DATABASE
   ========================================================= */

async function ensureTables(
  env
) {

  const queries = [

    `
    CREATE TABLE IF NOT EXISTS news (
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
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS news_loves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id TEXT,
      device_id TEXT,
      UNIQUE(news_id, device_id)
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS news_comments (
      id TEXT PRIMARY KEY,
      news_id TEXT,
      author_name TEXT,
      comment_text TEXT,
      created_at TEXT
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT UNIQUE,
      keys_json TEXT,
      created_at TEXT
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS affiliate_clicks (
      id TEXT PRIMARY KEY,
      affiliate_name TEXT,
      click_url TEXT,
      device_id TEXT,
      created_at TEXT
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS indexing_log (
      id TEXT PRIMARY KEY,
      news_id TEXT,
      url TEXT,
      status TEXT,
      response TEXT,
      created_at TEXT
    )
    `,

    `
    CREATE INDEX IF NOT EXISTS
    idx_news_status_published
    ON news(status, published_at DESC)
    `,

    `
    CREATE INDEX IF NOT EXISTS
    idx_news_category_published
    ON news(category, published_at DESC)
    `,

    `
    CREATE INDEX IF NOT EXISTS
    idx_news_score_published
    ON news(score DESC, published_at DESC)
    `,

    `
    CREATE INDEX IF NOT EXISTS
    idx_news_loves_news_id
    ON news_loves(news_id)
    `,

    `
    CREATE INDEX IF NOT EXISTS
    idx_news_comments_news_created
    ON news_comments(news_id, created_at ASC)
    `
  ];

  for (
    const sql of queries
  ) {

    await env.DB
      .prepare(sql)
      .run();
  }
}


async function ensureTablesOnce(
  env
) {

  if (
    !tablesReadyPromise
  ) {

    tablesReadyPromise =
      ensureTables(env);
  }

  try {

    await tablesReadyPromise;

  } catch (error) {

    tablesReadyPromise =
      null;

    throw error;
  }
}


/* =========================================================
   SHARE PAGE
   ========================================================= */

async function serveSharePage(
  id,
  env
) {

  const safeId =
    String(id || "")
      .trim();

  if (!safeId) {

    return Response.redirect(
      "https://ajkernews.in/",
      302
    );
  }

  const result =
    await env.DB
      .prepare(
        `
        SELECT
          headline,
          summary,
          image_url,
          published_at,
          source_name
        FROM news
        WHERE id = ?
          AND status = 'published'
        LIMIT 1
        `
      )
      .bind(safeId)
      .first();

  if (!result) {

    return Response.redirect(
      "https://ajkernews.in/",
      302
    );
  }

  const title =
    cleanText(
      result.headline ||
      "Ajker News"
    );

  const description =
    cleanText(
      result.summary || ""
    ).slice(0, 200);

  const image =
    result.image_url ||
    "";

  const shareUrl =
    `https://ajkernews.in/go/${encodeURIComponent(safeId)}`;

  const homeUrl =
    `https://ajkernews.in/?id=${encodeURIComponent(safeId)}`;

  const imageTags =
    image
      ? `
        <meta
          property="og:image"
          content="${escapeHtml(image)}"
        >

        <meta
          property="og:image:alt"
          content="${escapeHtml(title)}"
        >

        <meta
          name="twitter:image"
          content="${escapeHtml(image)}"
        >
        `
      : "";

  const html =
    `<!DOCTYPE html>
<html lang="bn">

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >

  <title>
    ${escapeHtml(title)}
  </title>

  <meta
    name="description"
    content="${escapeHtml(description)}"
  >

  <meta
    property="og:title"
    content="${escapeHtml(title)}"
  >

  <meta
    property="og:description"
    content="${escapeHtml(description)}"
  >

  <meta
    property="og:type"
    content="article"
  >

  <meta
    property="og:url"
    content="${escapeHtml(shareUrl)}"
  >

  <meta
    property="og:locale"
    content="bn_IN"
  >

  ${imageTags}

  <meta
    name="twitter:card"
    content="${
      image
        ? "summary_large_image"
        : "summary"
    }"
  >

  <meta
    name="twitter:title"
    content="${escapeHtml(title)}"
  >

  <meta
    name="twitter:description"
    content="${escapeHtml(description)}"
  >

  <meta
    name="twitter:url"
    content="${escapeHtml(shareUrl)}"
  >

  <meta
    http-equiv="refresh"
    content="0;url=${escapeHtml(homeUrl)}"
  >

  <script>
    window.location.replace(
      ${JSON.stringify(homeUrl)}
    );
  </script>

</head>

<body>

  <main
    style="
      font-family:sans-serif;
      padding:20px;
      line-height:1.7;
    "
  >

    <h1>
      ${escapeHtml(title)}
    </h1>

    <p>
      ${escapeHtml(description)}
    </p>

    <a
      href="${escapeHtml(homeUrl)}"
    >
      পুরো খবরটি পড়তে এখানে ক্লিক করুন
    </a>

  </main>

</body>

</html>`;

  return new Response(
    html,
    {
      status: 200,
      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",

        "Cache-Control":
          "public, max-age=300, s-maxage=300",

        "X-Content-Type-Options":
          "nosniff",

        ...corsHeaders()
      }
    }
  );
}


/* =========================================================
   NORMAL NEWS META PAGE
   ========================================================= */

async function serveNewsPage(
  url,
  env
) {

  const id =
    url.searchParams.get(
      "id"
    );

  if (!id) {

    return Response.redirect(
      "https://ajkernews.in/",
      302
    );
  }

  const result =
    await env.DB
      .prepare(
        `
        SELECT
          headline,
          summary,
          image_url,
          published_at,
          source_name
        FROM news
        WHERE id = ?
          AND status = 'published'
        LIMIT 1
        `
      )
      .bind(id)
      .first();

  if (!result) {

    return Response.redirect(
      "https://ajkernews.in/",
      302
    );
  }

  const title =
    cleanText(
      result.headline
    ) ||
    "Ajker News";

  const description =
    cleanText(
      result.summary || ""
    ).slice(0, 160);

  const image =
    result.image_url ||
    "";

  const homeUrl =
    `https://ajkernews.in/?id=${encodeURIComponent(id)}`;

  const imageTags =
    image
      ? `
        <meta
          property="og:image"
          content="${escapeHtml(image)}"
        >

        <meta
          property="og:image:alt"
          content="${escapeHtml(title)}"
        >

        <meta
          name="twitter:image"
          content="${escapeHtml(image)}"
        >
        `
      : "";

  let html =
    `<!DOCTYPE html>

<html lang="bn">

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >

  <title>
    ${escapeHtml(title)}
    - Ajker News
  </title>

  <meta
    name="description"
    content="${escapeHtml(description)}"
  >

  <meta
    property="og:title"
    content="${escapeHtml(title)}"
  >

  <meta
    property="og:description"
    content="${escapeHtml(description)}"
  >

  <meta
    property="og:url"
    content="${escapeHtml(homeUrl)}"
  >

  <meta
    property="og:type"
    content="article"
  >

  ${imageTags}

  <meta
    name="twitter:card"
    content="${
      image
        ? "summary_large_image"
        : "summary"
    }"
  >

  <meta
    name="twitter:title"
    content="${escapeHtml(title)}"
  >

  <meta
    name="twitter:description"
    content="${escapeHtml(description)}"
  >

  <meta
    http-equiv="refresh"
    content="0;url=${escapeHtml(homeUrl)}"
  >

  <script>
    window.location.replace(
      ${JSON.stringify(homeUrl)}
    );
  </script>

</head>

<body>

  <p>
    ${escapeHtml(title)}
  </p>

</body>

</html>`;

  const analyticsScript =
    `
    <script async
      src="https://www.googletagmanager.com/gtag/js?id=${ANALYTICS_CONFIG.gaTrackingId}">
    </script>

    <script>
      window.dataLayer =
        window.dataLayer || [];

      function gtag(){
        dataLayer.push(arguments);
      }

      gtag(
        "js",
        new Date()
      );

      gtag(
        "config",
        "${ANALYTICS_CONFIG.gaTrackingId}"
      );
    </script>

    ${
      ANALYTICS_CONFIG.extraHeadScripts ||
      ""
    }

    ${
      ADS_CONFIG.adNetworkScripts ||
      ""
    }
    `;

  html =
    html.replace(
      "</head>",
      analyticsScript +
      "</head>"
    );

  if (
    ADS_CONFIG.extraFooterScripts
  ) {

    html =
      html.replace(
        "</body>",
        ADS_CONFIG
          .extraFooterScripts +
        "</body>"
      );
  }

  return new Response(
    html,
    {
      status: 200,

      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",

        "Cache-Control":
          "public, max-age=300, s-maxage=300",

        ...corsHeaders()
      }
    }
  );
}


/* =========================================================
   AFFILIATE
   ========================================================= */

async function handleAffiliate(
  url,
  env
) {

  const ref =
    url.searchParams.get(
      "ref"
    ) ||
    "direct";

  let targetUrl =
    url.searchParams.get(
      "url"
    );

  if (
    !targetUrl &&
    AFFILIATE_CONFIG
      .redirectMap &&
    AFFILIATE_CONFIG
      .redirectMap[ref]
  ) {

    targetUrl =
      AFFILIATE_CONFIG
        .redirectMap[ref];
  }

  if (!targetUrl) {

    targetUrl =
      AFFILIATE_CONFIG
        .defaultRedirect;
  }

  if (
    AFFILIATE_CONFIG.trackClicks
  ) {

    try {

      const deviceId =
        requestSafeIp(
          url
        );

      await env.DB
        .prepare(
          `
          INSERT INTO affiliate_clicks
          (
            id,
            affiliate_name,
            click_url,
            device_id,
            created_at
          )
          VALUES (?, ?, ?, ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          ref,
          targetUrl,
          deviceId,
          new Date()
            .toISOString()
        )
        .run();

    } catch (error) {

      console.error(
        "Affiliate log error:",
        error
      );
    }
  }

  return Response.redirect(
    targetUrl,
    302
  );
}

function requestSafeIp() {
  return "unknown";
}


/* =========================================================
   NEWS UPDATE
   ========================================================= */

async function updateNews(
  env
) {

  if (!env.DB) {

    throw new Error(
      "D1 binding DB is missing"
    );
  }

  if (
    !env.GNEWS_API_KEY
  ) {

    throw new Error(
      "GNEWS_API_KEY secret is missing"
    );
  }

  /*
   * Gemini is optional for reliability.
   *
   * If the key is missing or Gemini fails,
   * GNews fallback will still publish news.
   */

  let candidates = [];

  try {

    candidates =
      await fetchGNews(
        env
      );

  } catch (error) {

    console.error(
      "GNews fetch failed:",
      error
    );

    return {
      fetched: 0,
      unique: 0,
      selected: 0,
      stored: 0,
      deleted: 0,
      indexed: 0,
      gemini: false,
      fallback: false,
      message:
        "GNews fetch failed"
    };
  }

  if (
    !candidates.length
  ) {

    return {
      fetched: 0,
      unique: 0,
      selected: 0,
      stored: 0,
      deleted: 0,
      indexed: 0,
      gemini: false,
      fallback: false,
      message:
        "No news found"
    };
  }


  /* -----------------------------------------
     Remove duplicates
     ----------------------------------------- */

  const uniqueCandidates =
    await removeExistingNews(
      candidates,
      env
    );

  if (
    !uniqueCandidates.length
  ) {

    return {
      fetched:
        candidates.length,

      unique: 0,

      selected: 0,

      stored: 0,

      deleted: 0,

      indexed: 0,

      gemini: false,

      fallback: false,

      message:
        "No new news available"
    };
  }


  /* -----------------------------------------
     Gemini processing
     ----------------------------------------- */

  let selected = [];

  let usedGemini =
    false;

  let usedFallback =
    false;

  if (
    env.GEMINI_API_KEY
  ) {

    try {

      selected =
        await processWithGemini(
          uniqueCandidates,
          env
        );

      usedGemini =
        selected.length > 0;

    } catch (error) {

      console.error(
        "Gemini processing failed:",
        error
      );
    }
  }


  /* -----------------------------------------
     Safe fallback
     ----------------------------------------- */

  if (
    !selected.length
  ) {

    console.log(
      "Using GNews fallback."
    );

    selected =
      buildFallbackNews(
        uniqueCandidates
      );

    usedFallback =
      true;
  }


  const finalNews =
    selected
      .slice(
        0,
        MAX_SELECTED_NEWS
      );


  let stored = 0;

  const indexedUrls = [];


  /* -----------------------------------------
     Insert
     ----------------------------------------- */

  for (
    const news of finalNews
  ) {

    try {

      await insertNews(
        news,
        env
      );

      stored++;

      indexedUrls.push(
        `https://ajkernews.in/?id=${news.id}`
      );

    } catch (error) {

      console.error(
        "News insert failed:",
        error
      );
    }
  }


  /* -----------------------------------------
     Keep database small
     ----------------------------------------- */

  const deleted =
    await enforceMaximumNews(
      env
    );


  /* -----------------------------------------
     Google indexing
     ----------------------------------------- */

  let indexed = 0;

  if (
    stored > 0 &&
    env.GOOGLE_SERVICE_ACCOUNT_JSON
  ) {

    for (
      const newsUrl of
      indexedUrls
    ) {

      let success = false;

      for (
        let attempt = 1;
        attempt <= 2;
        attempt++
      ) {

        success =
          await requestGoogleIndexing(
            newsUrl,
            env
          );

        if (success) {
          indexed++;
          break;
        }

        await sleep(
          1500 * attempt
        );
      }
    }

    await pingSearchEngines();
  }


  return {

    fetched:
      candidates.length,

    unique:
      uniqueCandidates.length,

    selected:
      finalNews.length,

    stored,

    deleted,

    indexed,

    gemini:
      usedGemini,

    fallback:
      usedFallback,

    message:
      `News update completed. ${stored} stored. Gemini: ${usedGemini ? "yes" : "no"}. Fallback: ${usedFallback ? "yes" : "no"}.`
  };
}


/* =========================================================
   GNEWS
   ========================================================= */

async function fetchGNews(
  env
) {

  const results = [];

  /*
   * Bengali feed
   */
  try {

    const bn =
      await fetchGNewsFeed(
        env,
        "bn"
      );

    results.push(
      ...bn
    );

  } catch (error) {

    console.error(
      "Bengali GNews failed:",
      error
    );
  }


  /*
   * English feed
   *
   * This improves coverage for
   * international / technology /
   * business stories.
   */
  try {

    const en =
      await fetchGNewsFeed(
        env,
        "en"
      );

    results.push(
      ...en
    );

  } catch (error) {

    console.error(
      "English GNews failed:",
      error
    );
  }


  /*
   * Deduplicate by URL.
   */

  const seen =
    new Set();

  const unique = [];

  for (
    const item of results
  ) {

    if (
      !item.source_url
    ) {
      continue;
    }

    if (
      seen.has(
        item.source_url
      )
    ) {
      continue;
    }

    seen.add(
      item.source_url
    );

    unique.push(
      item
    );
  }

  return unique
    .slice(
      0,
      20
    );
}


async function fetchGNewsFeed(
  env,
  language
) {

  const apiUrl =
    new URL(
      "https://gnews.io/api/v4/top-headlines"
    );

  apiUrl.searchParams.set(
    "lang",
    language
  );

  apiUrl.searchParams.set(
    "country",
    "in"
  );

  apiUrl.searchParams.set(
    "max",
    String(
      GNEWS_MAX_RESULTS
    )
  );

  apiUrl.searchParams.set(
    "apikey",
    env.GNEWS_API_KEY
  );

  const response =
    await fetch(
      apiUrl.toString(),
      {
        method: "GET",

        headers: {
          accept:
            "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `GNews ${language} API ${response.status}: ${await response.text()}`
    );
  }

  const data =
    await response.json();

  if (
    !data ||
    !Array.isArray(
      data.articles
    )
  ) {

    return [];
  }

  return data.articles
    .slice(
      0,
      GNEWS_MAX_RESULTS
    )
    .map(
      article => ({

        source_name:
          cleanText(
            article.source?.name ||
            ""
          ),

        source_url:
          normalizeUrl(
            article.url ||
            ""
          ),

        source_title:
          cleanText(
            article.title ||
            ""
          ),

        source_description:
          cleanText(
            article.description ||
            ""
          ),

        image_url:
          article.image ||
          "",

        published_at:
          article.publishedAt ||
          ""
      })
    )
    .filter(
      article =>
        article.source_url &&
        article.source_title
    );
}


/* =========================================================
   EXISTING NEWS FILTER
   ========================================================= */

async function removeExistingNews(
  candidates,
  env
) {

  const unique = [];

  const checked =
    new Set();

  for (
    const item of candidates
  ) {

    const sourceUrl =
      normalizeUrl(
        item.source_url
      );

    if (!sourceUrl) {
      continue;
    }

    if (
      checked.has(
        sourceUrl
      )
    ) {
      continue;
    }

    checked.add(
      sourceUrl
    );

    const existing =
      await env.DB
        .prepare(
          `
          SELECT id
          FROM news
          WHERE source_url = ?
          LIMIT 1
          `
        )
        .bind(
          sourceUrl
        )
        .first();

    if (!existing) {

      unique.push({
        ...item,
        source_url:
          sourceUrl
      });
    }
  }

  return unique;
}


/* =========================================================
   GEMINI
   ========================================================= */

async function processWithGemini(
  candidates,
  env
) {

  const input =
    candidates.map(
      (
        item,
        index
      ) => ({

        candidate_id:
          index + 1,

        source:
          item.source_name,

        title:
          item.source_title,

        description:
          item.source_description,

        published_at:
          item.published_at
      })
    );


  const prompt = `
You are the senior editor of Ajker News,
a Bengali news website for Bengali readers in India.

Select the 5 most important NEW stories.

PRIORITY:
1. West Bengal:
   Kolkata, Mamata Banerjee, TMC, BJP Bengal,
   West Bengal government, Bengal politics,
   Bengal crime, Bengal development and elections.
2. India national politics.
3. Major international news.
4. Business.
5. Technology.
6. Sports.
7. Entertainment.

Important:
- Select only from the supplied candidates.
- Never invent facts.
- Never invent quotes.
- Never invent statistics.
- Do not copy source titles word-for-word.
- Write natural professional Bengali.
- Do not use clickbait.
- Summary should be around 90-130 Bengali words.
- Keep the headline concise.
- If the source is already Bengali, rewrite it naturally.
- Return ONLY a JSON array.

Each object MUST be:

{
  "candidate_id": 1,
  "headline": "...",
  "summary": "...",
  "main_topic": "...",
  "category": "west_bengal",
  "score": 90
}

Allowed categories:
west_bengal,
india,
world,
politics,
business,
sports,
technology,
entertainment,
general

Candidates:
${JSON.stringify(input)}
`;


  let lastError =
    null;


  /*
   * Try models one by one.
   */

  for (
    const model of
    GEMINI_MODELS
  ) {

    try {

      const result =
        await callGeminiModel(
          model,
          prompt,
          env
        );

      if (
        Array.isArray(
          result
        ) &&
        result.length
      ) {

        return validateGeminiResults(
          result,
          candidates
        );
      }

    } catch (error) {

      lastError =
        error;

      console.error(
        `Gemini model ${model} failed:`,
        error
      );

      /*
       * Small delay before fallback model.
       */
      await sleep(1200);
    }
  }


  throw (
    lastError ||
    new Error(
      "All Gemini models failed"
    )
  );
}


async function callGeminiModel(
  model,
  prompt,
  env
) {

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;


  /*
   * Only one retry for transient errors.
   *
   * This keeps Free Tier usage low.
   */

  let lastResponseText =
    "";

  for (
    let attempt = 1;
    attempt <= 2;
    attempt++
  ) {

    const response =
      await fetch(
        endpoint,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json"
          },

          body:
            JSON.stringify({

              contents: [
                {
                  parts: [
                    {
                      text:
                        prompt
                    }
                  ]
                }
              ],

              generationConfig: {

                temperature:
                  0.2,

                responseMimeType:
                  "application/json",

                maxOutputTokens:
                  5000
              }
            })
        }
      );


    lastResponseText =
      await response.text();


    if (
      response.ok
    ) {

      let data;

      try {

        data =
          JSON.parse(
            lastResponseText
          );

      } catch {

        throw new Error(
          "Gemini returned invalid JSON response body"
        );
      }


      const text =
        data?.candidates?.[0]
          ?.content?.parts?.[0]
          ?.text;


      if (!text) {

        throw new Error(
          "Gemini returned empty response"
        );
      }


      let parsed;

      try {

        parsed =
          JSON.parse(
            cleanJson(text)
          );

      } catch {

        throw new Error(
          "Gemini returned invalid JSON content"
        );
      }


      if (
        !Array.isArray(
          parsed
        )
      ) {

        throw new Error(
          "Gemini response is not an array"
        );
      }

      return parsed;
    }


    /*
     * Retry only transient errors.
     */

    if (
      response.status === 429 ||
      response.status === 500 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {

      if (
        attempt < 2
      ) {

        await sleep(
          2000
        );

        continue;
      }
    }


    throw new Error(
      `Gemini API ${response.status}: ${lastResponseText}`
    );
  }


  throw new Error(
    `Gemini request failed: ${lastResponseText}`
  );
}


/* =========================================================
   VALIDATE GEMINI
   ========================================================= */

function validateGeminiResults(
  parsed,
  candidates
) {

  const results = [];

  const usedIds =
    new Set();

  for (
    const item of parsed
  ) {

    const candidateId =
      Number(
        item?.candidate_id
      );

    if (
      !Number.isInteger(
        candidateId
      )
    ) {
      continue;
    }

    if (
      candidateId < 1 ||
      candidateId >
        candidates.length
    ) {
      continue;
    }

    if (
      usedIds.has(
        candidateId
      )
    ) {
      continue;
    }

    usedIds.add(
      candidateId
    );


    const original =
      candidates[
        candidateId - 1
      ];

    if (!original) {
      continue;
    }


    const headline =
      cleanText(
        item.headline
      );

    const summary =
      cleanText(
        item.summary
      );

    const topic =
      cleanText(
        item.main_topic
      );


    if (
      !headline ||
      !summary
    ) {
      continue;
    }


    results.push({

      ...original,

      headline,

      summary,

      main_topic:
        topic ||
        "সর্বশেষ খবর",

      category:
        normalizeCategory(
          item.category
        ),

      score:
        clampScore(
          item.score
        )
    });
  }


  results.sort(
    (a, b) =>
      b.score -
      a.score
  );


  return results;
}


/* =========================================================
   SAFE FALLBACK
   ========================================================= */

function buildFallbackNews(
  candidates
) {

  return candidates
    .map(
      item => {

        const title =
          cleanText(
            item.source_title
          );

        const description =
          cleanText(
            item.source_description
          );


        const category =
          detectFallbackCategory(
            `${title} ${description}`
          );


        const score =
          fallbackScore(
            `${title} ${description}`,
            category
          );


        return {

          ...item,

          headline:
            title,

          summary:
            description ||
            `${title} সম্পর্কে সর্বশেষ তথ্য জানতে Ajker News-এর আপডেট দেখুন।`,

          main_topic:
            fallbackTopic(
              category
            ),

          category,

          score
        };
      }
    )
    .sort(
      (a, b) =>
        b.score -
        a.score
    );
}


function detectFallbackCategory(
  text
) {

  const value =
    String(text || "")
      .toLowerCase();


  const westBengalWords = [
    "west bengal",
    "kolkata",
    "bengal",
    "mamata",
    "banerjee",
    "tmc",
    "trinamool",
    "bjp bengal",
    "calcutta"
  ];


  if (
    westBengalWords.some(
      word =>
        value.includes(
          word
        )
    )
  ) {

    return "west_bengal";
  }


  if (
    /india|indian|delhi|modi|parliament|election/.test(
      value
    )
  ) {

    return "india";
  }


  if (
    /business|market|stock|economy|bank|company|finance/.test(
      value
    )
  ) {

    return "business";
  }


  if (
    /technology|tech|ai|iphone|google|microsoft|software/.test(
      value
    )
  ) {

    return "technology";
  }


  if (
    /sport|cricket|football|tennis|olympic/.test(
      value
    )
  ) {

    return "sports";
  }


  if (
    /movie|film|actor|actress|music|entertainment/.test(
      value
    )
  ) {

    return "entertainment";
  }


  if (
    /world|america|usa|ukraine|russia|china|israel|iran/.test(
      value
    )
  ) {

    return "world";
  }


  return "general";
}


function fallbackTopic(
  category
) {

  const topics = {

    west_bengal:
      "পশ্চিমবঙ্গ",

    india:
      "ভারত",

    world:
      "বিশ্ব",

    politics:
      "রাজনীতি",

    business:
      "ব্যবসা",

    sports:
      "খেলা",

    technology:
      "প্রযুক্তি",

    entertainment:
      "বিনোদন",

    general:
      "সর্বশেষ খবর"
  };

  return (
    topics[category] ||
    topics.general
  );
}


function fallbackScore(
  text,
  category
) {

  let score = 50;


  if (
    category ===
    "west_bengal"
  ) {
    score += 40;
  }

  if (
    category ===
    "india"
  ) {
    score += 25;
  }


  if (
    /breaking|major|latest|election|government|minister/.test(
      String(text)
        .toLowerCase()
    )
  ) {

    score += 10;
  }


  return clampScore(
    score
  );
}


/* =========================================================
   INSERT NEWS
   ========================================================= */

async function insertNews(
  item,
  env
) {

  const id =
    crypto.randomUUID();

  const createdAt =
    new Date()
      .toISOString();

  const dayKey =
    createdAt.slice(
      0,
      10
    );


  const searchText =
    toTransliterated(
      [
        item.headline,
        item.summary,
        item.main_topic,
        item.category
      ]
        .filter(Boolean)
        .join(" ")
    );


  await env.DB
    .prepare(
      `
      INSERT INTO news
      (
        id,
        source_url,
        source_name,
        source_title,
        source_description,
        headline,
        summary,
        main_topic,
        category,
        image_url,
        published_at,
        created_at,
        day_key,
        status,
        score,
        search_text,
        indexed_at
      )
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(

      id,

      item.source_url,

      item.source_name,

      item.source_title,

      item.source_description,

      item.headline,

      item.summary,

      item.main_topic,

      item.category,

      item.image_url,

      item.published_at,

      createdAt,

      dayKey,

      "published",

      item.score,

      searchText,

      null
    )
    .run();


  item.id =
    id;
}


/* =========================================================
   GET NEWS
   ========================================================= */

async function handleGetNews(
  url,
  env
) {

  const category =
    url.searchParams.get(
      "category"
    ) ||
    "top";


  const query =
    (
      url.searchParams.get(
        "q"
      ) ||
      ""
    ).trim();


  const specificId =
    url.searchParams.get(
      "id"
    );


  const offset =
    Math.max(
      0,
      parseInt(
        url.searchParams.get(
          "offset"
        ) ||
        "0",
        10
      )
    );


  /*
   * Fetch 26 to determine whether
   * another page exists.
   *
   * Frontend shows only 25.
   */

  const queryLimit =
    API_PAGE_SIZE + 1;


  const selectFields = `
    news.id,
    news.headline,
    news.summary,
    news.main_topic,
    news.category,
    news.image_url,
    news.published_at,
    news.source_name,
    news.source_url,
    news.created_at,
    news.score,
    (
      SELECT COUNT(*)
      FROM news_loves nl
      WHERE nl.news_id =
        news.id
    ) AS love_count
  `;


  /* -----------------------------------------
     Specific news
     ----------------------------------------- */

  if (
    specificId
  ) {

    const result =
      await env.DB
        .prepare(
          `
          SELECT
            ${selectFields}
          FROM news
          WHERE news.id = ?
            AND news.status = 'published'
          `
        )
        .bind(
          specificId
        )
        .all();


    const news =
      result.results || [];


    return json(
      {
        success: true,
        count:
          news.length,
        news
      },
      200,
      300
    );
  }


  let result;


  /* -----------------------------------------
     Search
     ----------------------------------------- */

  if (query) {

    const transliterated =
      toTransliterated(
        query
      );


    result =
      await env.DB
        .prepare(
          `
          SELECT
            ${selectFields}
          FROM news
          WHERE news.status =
            'published'
            AND (
              news.search_text
                LIKE ?
              OR news.headline
                LIKE ?
              OR news.summary
                LIKE ?
              OR news.main_topic
                LIKE ?
            )
          ORDER BY
            news.published_at DESC
          LIMIT ?
          OFFSET ?
          `
        )
        .bind(

          `%${transliterated}%`,

          `%${query}%`,

          `%${query}%`,

          `%${query}%`,

          queryLimit,

          offset
        )
        .all();


  }


  /* -----------------------------------------
     Trending
     ----------------------------------------- */

  else if (
    category ===
    "trending"
  ) {

    result =
      await env.DB
        .prepare(
          `
          SELECT
            ${selectFields}
          FROM news
          WHERE news.status =
            'published'
          ORDER BY
            news.score DESC,
            news.published_at DESC
          LIMIT ?
          OFFSET ?
          `
        )
        .bind(
          queryLimit,
          offset
        )
        .all();


  }


  /* -----------------------------------------
     Category
     ----------------------------------------- */

  else if (
    category !== "top" &&
    category !== "all"
  ) {

    result =
      await env.DB
        .prepare(
          `
          SELECT
            ${selectFields}
          FROM news
          WHERE news.status =
            'published'
            AND news.category = ?
          ORDER BY
            news.published_at DESC
          LIMIT ?
          OFFSET ?
          `
        )
        .bind(
          category,
          queryLimit,
          offset
        )
        .all();


  }


  /* -----------------------------------------
     Top / all
     ----------------------------------------- */

  else {

    result =
      await env.DB
        .prepare(
          `
          SELECT
            ${selectFields}
          FROM news
          WHERE news.status =
            'published'
          ORDER BY
            news.published_at DESC
          LIMIT ?
          OFFSET ?
          `
        )
        .bind(
          queryLimit,
          offset
        )
        .all();
  }


  const rawNews =
    result?.results ||
    [];


  const hasMore =
    rawNews.length >
    API_PAGE_SIZE;


  const news =
    rawNews.slice(
      0,
      API_PAGE_SIZE
    );


  return json(
    {
      success: true,

      count:
        news.length,

      offset,

      limit:
        API_PAGE_SIZE,

      has_more:
        hasMore,

      news
    },
    200,
    30
  );
}


/* =========================================================
   DATABASE LIMIT
   ========================================================= */

async function enforceMaximumNews(
  env
) {

  const result =
    await env.DB
      .prepare(
        `
        SELECT
          COUNT(*) AS total
        FROM news
        `
      )
      .first();


  const total =
    Number(
      result?.total ||
      0
    );


  if (
    total <= MAX_NEWS
  ) {

    return 0;
  }


  const deleteCount =
    total -
    MAX_NEWS;


  const old =
    await env.DB
      .prepare(
        `
        SELECT id
        FROM news
        ORDER BY
          created_at ASC
        LIMIT ?
        `
      )
      .bind(
        deleteCount
      )
      .all();


  const ids =
    (
      old.results ||
      []
    )
      .map(
        row =>
          row.id
      );


  for (
    const id of ids
  ) {

    await env.DB
      .prepare(
        `
        DELETE FROM news_loves
        WHERE news_id = ?
        `
      )
      .bind(id)
      .run();


    await env.DB
      .prepare(
        `
        DELETE FROM news_comments
        WHERE news_id = ?
        `
      )
      .bind(id)
      .run();
  }


  if (
    ids.length
  ) {

    const placeholders =
      ids
        .map(
          () => "?"
        )
        .join(",");


    await env.DB
      .prepare(
        `
        DELETE FROM news
        WHERE id IN
          (${placeholders})
        `
      )
      .bind(
        ...ids
      )
      .run();
  }


  return deleteCount;
}


/* =========================================================
   PUSH SUBSCRIPTION
   ========================================================= */

async function handleSubscribe(
  request,
  env
) {

  try {

    const subscription =
      await request.json();


    if (
      !subscription?.endpoint
    ) {

      return json(
        {
          success: false,
          error:
            "Invalid subscription"
        },
        400,
        0
      );
    }


    const endpoint =
      subscription.endpoint;


    const keys =
      JSON.stringify(
        subscription.keys ||
        {}
      );


    const existing =
      await env.DB
        .prepare(
          `
          SELECT id
          FROM push_subscriptions
          WHERE endpoint = ?
          LIMIT 1
          `
        )
        .bind(
          endpoint
        )
        .first();


    if (
      existing
    ) {

      /*
       * Update keys in case
       * browser rotated them.
       */

      await env.DB
        .prepare(
          `
          UPDATE push_subscriptions
          SET keys_json = ?
          WHERE endpoint = ?
          `
        )
        .bind(
          keys,
          endpoint
        )
        .run();


      return json(
        {
          success: true,
          message:
            "Subscription updated"
        },
        200,
        0
      );
    }


    await env.DB
      .prepare(
        `
        INSERT INTO push_subscriptions
        (
          id,
          endpoint,
          keys_json,
          created_at
        )
        VALUES (?, ?, ?, ?)
        `
      )
      .bind(

        crypto.randomUUID(),

        endpoint,

        keys,

        new Date()
          .toISOString()
      )
      .run();


    return json(
      {
        success: true
      },
      200,
      0
    );

  } catch (error) {

    console.error(
      "Subscribe error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error?.message ||
          "Subscribe error"
      },
      500,
      0
    );
  }
}


/* =========================================================
   PUSH SENDING
   ========================================================= */

async function sendPushNotifications(
  env,
  title,
  body,
  url
) {

  if (
    !env.VAPID_PUBLIC_KEY ||
    !env.VAPID_PRIVATE_KEY
  ) {

    console.warn(
      "VAPID keys are missing."
    );

    return;
  }


  const subscriptions =
    await env.DB
      .prepare(
        `
        SELECT
          endpoint,
          keys_json
        FROM push_subscriptions
        `
      )
      .all();


  if (
    !subscriptions.results?.length
  ) {

    console.log(
      "No push subscriptions."
    );

    return;
  }


  webPush.setVapidDetails(

    "mailto:info.ajkernews@gmail.com",

    env.VAPID_PUBLIC_KEY,

    env.VAPID_PRIVATE_KEY
  );


  const payload =
    JSON.stringify({

      title,

      body,

      url,

      icon:
        "/assets/logo.png",

      badge:
        "/assets/logo.png"
    });


  for (
    const sub of
    subscriptions.results
  ) {

    try {

      await webPush
        .sendNotification(
          {
            endpoint:
              sub.endpoint,

            keys:
              JSON.parse(
                sub.keys_json
              )
          },
          payload
        );


      console.log(
        "Push sent:",
        sub.endpoint
      );

    } catch (error) {

      console.error(
        "Push send error:",
        error
      );


      /*
       * Browser subscription expired.
       */

      if (
        error?.statusCode ===
          410 ||
        error?.statusCode ===
          404
      ) {

        await env.DB
          .prepare(
            `
            DELETE FROM
              push_subscriptions
            WHERE endpoint = ?
            `
          )
          .bind(
            sub.endpoint
          )
          .run();
      }
    }
  }
}


/* =========================================================
   LOVE
   ========================================================= */

async function toggleLove(
  request,
  env
) {

  try {

    const {
      id,
      deviceId
    } =
      await request.json();


    if (
      !id ||
      !deviceId
    ) {

      return json(
        {
          error:
            "Missing id or deviceId"
        },
        400,
        0
      );
    }


    const existing =
      await env.DB
        .prepare(
          `
          SELECT id
          FROM news_loves
          WHERE news_id = ?
            AND device_id = ?
          `
        )
        .bind(
          id,
          deviceId
        )
        .first();


    if (
      existing
    ) {

      await env.DB
        .prepare(
          `
          DELETE FROM news_loves
          WHERE news_id = ?
            AND device_id = ?
          `
        )
        .bind(
          id,
          deviceId
        )
        .run();

    } else {

      await env.DB
        .prepare(
          `
          INSERT INTO news_loves
          (
            news_id,
            device_id
          )
          VALUES (?, ?)
          `
        )
        .bind(
          id,
          deviceId
        )
        .run();
    }


    const count =
      await env.DB
        .prepare(
          `
          SELECT
            COUNT(*) AS count
          FROM news_loves
          WHERE news_id = ?
          `
        )
        .bind(id)
        .first();


    return json(
      {
        success: true,

        love_count:
          Number(
            count?.count ||
            0
          )
      },
      200,
      0
    );

  } catch (error) {

    return json(
      {
        success: false,

        error:
          error?.message ||
          "Love error"
      },
      500,
      0
    );
  }
}


/* =========================================================
   COMMENTS
   ========================================================= */

async function getComments(
  url,
  env
) {

  const id =
    url.searchParams.get(
      "id"
    );


  if (!id) {

    return json(
      {
        error:
          "Missing id"
      },
      400,
      0
    );
  }


  const result =
    await env.DB
      .prepare(
        `
        SELECT
          id,
          author_name,
          comment_text,
          created_at
        FROM news_comments
        WHERE news_id = ?
        ORDER BY
          created_at ASC
        `
      )
      .bind(id)
      .all();


  return json(
    {
      comments:
        result.results ||
        []
    },
    200,
    30
  );
}


async function addComment(
  request,
  env
) {

  try {

    const {
      newsId,
      author,
      text
    } =
      await request.json();


    if (
      !newsId ||
      !text
    ) {

      return json(
        {
          error:
            "Missing fields"
        },
        400,
        0
      );
    }


    const id =
      crypto.randomUUID();


    await env.DB
      .prepare(
        `
        INSERT INTO news_comments
        (
          id,
          news_id,
          author_name,
          comment_text,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
        `
      )
      .bind(

        id,

        newsId,

        cleanText(
          author ||
          "Guest"
        ),

        cleanText(
          text
        ),

        new Date()
          .toISOString()
      )
      .run();


    return json(
      {
        success: true,

        comment_id:
          id
      },
      200,
      0
    );

  } catch (error) {

    return json(
      {
        success: false,

        error:
          error?.message ||
          "Comment error"
      },
      500,
      0
    );
  }
}


/* =========================================================
   GOOGLE INDEXING
   ========================================================= */

async function requestGoogleIndexing(
  url,
  env
) {

  try {

    const token =
      await getGoogleAccessToken(
        env
      );


    if (!token) {
      return false;
    }


    const response =
      await fetch(
        "https://indexing.googleapis.com/v3/urlNotifications:publish",
        {
          method: "POST",

          headers: {
            "Authorization":
              `Bearer ${token}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              url,
              type:
                "URL_UPDATED"
            })
        }
      );


    const responseText =
      await response.text();


    try {

      await env.DB
        .prepare(
          `
          INSERT INTO indexing_log
          (
            id,
            news_id,
            url,
            status,
            response,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .bind(

          crypto.randomUUID(),

          getIdFromNewsUrl(
            url
          ),

          url,

          response.ok
            ? "success"
            : "failed",

          responseText,

          new Date()
            .toISOString()
        )
        .run();

    } catch (error) {

      console.error(
        "Indexing log error:",
        error
      );
    }


    return response.ok;

  } catch (error) {

    console.error(
      "Indexing API error:",
      error
    );

    return false;
  }
}


function getIdFromNewsUrl(
  url
) {

  try {

    return (
      new URL(url)
        .searchParams
        .get("id") ||
      "unknown"
    );

  } catch {

    return "unknown";
  }
}


/* =========================================================
   GOOGLE ACCESS TOKEN
   ========================================================= */

async function getGoogleAccessToken(
  env
) {

  try {

    if (
      !env.GOOGLE_SERVICE_ACCOUNT_JSON
    ) {

      return null;
    }


    const credentials =
      JSON.parse(
        env.GOOGLE_SERVICE_ACCOUNT_JSON
      );


    const now =
      Math.floor(
        Date.now() / 1000
      );


    const header = {
      alg: "RS256",
      typ: "JWT"
    };


    const claimSet = {

      iss:
        credentials.client_email,

      scope:
        "https://www.googleapis.com/auth/indexing",

      aud:
        "https://oauth2.googleapis.com/token",

      exp:
        now + 3600,

      iat:
        now
    };


    const encodedHeader =
      base64UrlEncode(
        JSON.stringify(
          header
        )
      );


    const encodedClaimSet =
      base64UrlEncode(
        JSON.stringify(
          claimSet
        )
      );


    const signatureInput =
      `${encodedHeader}.${encodedClaimSet}`;


    const cryptoKey =
      await crypto.subtle
        .importKey(

          "pkcs8",

          pemToArrayBuffer(
            credentials.private_key
          ),

          {
            name:
              "RSASSA-PKCS1-v1_5",

            hash:
              "SHA-256"
          },

          false,

          ["sign"]
        );


    const signature =
      await crypto.subtle.sign(

        "RSASSA-PKCS1-v1_5",

        cryptoKey,

        new TextEncoder()
          .encode(
            signatureInput
          )
      );


    const encodedSignature =
      base64UrlEncode(
        String.fromCharCode(
          ...new Uint8Array(
            signature
          )
        )
      );


    const jwt =
      `${signatureInput}.${encodedSignature}`;


    const response =
      await fetch(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body:
            new URLSearchParams({

              grant_type:
                "urn:ietf:params:oauth:grant-type:jwt-bearer",

              assertion:
                jwt

            })
        }
      );


    if (
      !response.ok
    ) {

      return null;
    }


    const data =
      await response.json();


    return (
      data.access_token ||
      null
    );

  } catch (error) {

    console.error(
      "Token generation error:",
      error
    );

    return null;
  }
}


/* =========================================================
   SEARCH ENGINE PING
   ========================================================= */

async function pingSearchEngines() {

  const sitemapUrl =
    encodeURIComponent(
      "https://ajkernews.in/sitemap.xml"
    );


  try {

    await fetch(
      `https://www.google.com/ping?sitemap=${sitemapUrl}`
    );

  } catch {}


  try {

    await fetch(
      `https://www.bing.com/ping?sitemap=${sitemapUrl}`
    );

  } catch {}
}


/* =========================================================
   SITEMAP
   ========================================================= */

async function generateSitemap(
  env
) {

  const result =
    await env.DB
      .prepare(
        `
        SELECT
          id,
          created_at
        FROM news
        WHERE status =
          'published'
        ORDER BY
          created_at DESC
        LIMIT 200
        `
      )
      .all();


  const news =
    result.results ||
    [];


  const baseUrl =
    "https://ajkernews.in";


  let xml =
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;


  xml +=
    `
    <url>
      <loc>${baseUrl}/</loc>
      <changefreq>daily</changefreq>
      <priority>1.0</priority>
    </url>
    `;


  for (
    const item of news
  ) {

    const lastmod =
      item.created_at
        ? item.created_at
            .split("T")[0]
        : new Date()
            .toISOString()
            .split("T")[0];


    xml +=
      `
      <url>
        <loc>
          ${baseUrl}/?id=${encodeURIComponent(item.id)}
        </loc>
        <lastmod>${lastmod}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.8</priority>
      </url>
      `;
  }


  xml +=
    `</urlset>`;


  return new Response(
    xml,
    {
      status: 200,

      headers: {
        "Content-Type":
          "application/xml",

        "Cache-Control":
          "public, max-age=3600",

        ...corsHeaders()
      }
    }
  );
}


/* =========================================================
   UTILITIES
   ========================================================= */

function normalizeUrl(
  url
) {

  try {

    const parsed =
      new URL(url);

    parsed.hash =
      "";

    return parsed
      .toString();

  } catch {

    return String(
      url || ""
    ).trim();
  }
}


function cleanText(
  value
) {

  return String(
    value || ""
  )
    .replace(
      /<[^>]*>/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function cleanJson(
  text
) {

  let value =
    String(
      text || ""
    ).trim();


  if (
    value.startsWith(
      "```"
    )
  ) {

    value =
      value
        .replace(
          /^```(?:json)?/i,
          ""
        )
        .replace(
          /```$/i,
          ""
        )
        .trim();
  }


  return value;
}


function normalizeCategory(
  category
) {

  const allowed =
    new Set([
      "west_bengal",
      "india",
      "world",
      "politics",
      "business",
      "sports",
      "technology",
      "entertainment",
      "general"
    ]);


  const value =
    String(
      category || ""
    )
      .trim()
      .toLowerCase();


  return allowed.has(
    value
  )
    ? value
    : "general";
}


function clampScore(
  score
) {

  const number =
    Number(score);


  if (
    !Number.isFinite(
      number
    )
  ) {

    return 0;
  }


  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        number
      )
    )
  );
}


function base64UrlEncode(
  str
) {

  return btoa(
    str
  )
    .replace(
      /\+/g,
      "-"
    )
    .replace(
      /\//g,
      "_"
    )
    .replace(
      /=+$/,
      ""
    );
}


function pemToArrayBuffer(
  pem
) {

  const lines =
    String(
      pem || ""
    ).split("\n");


  let base64 =
    "";


  for (
    const line of lines
  ) {

    if (
      !line.includes(
        "-----"
      )
    ) {

      base64 +=
        line.trim();
    }
  }


  const binary =
    atob(base64);


  const bytes =
    new Uint8Array(
      binary.length
    );


  for (
    let i = 0;
    i < binary.length;
    i++
  ) {

    bytes[i] =
      binary.charCodeAt(i);
  }


  return bytes.buffer;
}


function corsHeaders() {

  return {

    "access-control-allow-origin":
      "*",

    "access-control-allow-methods":
      "GET, POST, OPTIONS",

    "access-control-allow-headers":
      "Content-Type",

    "access-control-max-age":
      "86400"
  };
}


function json(
  data,
  status = 200,
  cacheSeconds = 60
) {

  const seconds =
    Math.max(
      0,
      Number(
        cacheSeconds
      ) || 0
    );


  return new Response(
    JSON.stringify(
      data
    ),
    {
      status,

      headers: {

        ...corsHeaders(),

        "content-type":
          "application/json; charset=UTF-8",

        "cache-control":
          `public, max-age=${seconds}, s-maxage=${seconds}`
      }
    }
  );
}


function escapeHtml(
  text
) {

  if (!text) {
    return "";
  }


  return String(text)

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /</g,
      "&lt;"
    )

    .replace(
      />/g,
      "&gt;"
    )

    .replace(
      /"/g,
      "&quot;"
    )

    .replace(
      /'/g,
      "&#039;"
    );
}


function sleep(
  ms
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}
