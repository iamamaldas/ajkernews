/*
 * Dynamic Google News Sitemap
 *
 * The sitemap is generated directly from D1.
 *
 * Only currently published news is included.
 * Deleted news automatically disappears from
 * the sitemap.
 */

const SITE_URL = "https://ajkernews.in";

const MAX_SITEMAP_NEWS = 100;


/*
 * Generate Google News sitemap.
 */
export async function generateNewsSitemap(
  db
) {

  const result =
    await db
      .prepare(`
        SELECT
          id,
          headline,
          published_at
        FROM news
        WHERE status = 'published'
        ORDER BY published_at DESC
        LIMIT ?
      `)
      .bind(MAX_SITEMAP_NEWS)
      .all();


  const articles =
    result.results || [];


  const urls =
    articles
      .map(article =>
        createNewsUrl(article)
      )
      .join("\n");


  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
>
${urls}
</urlset>`;


  return new Response(
    xml,
    {
      status: 200,

      headers: {
        "Content-Type":
          "application/xml; charset=UTF-8",

        /*
         * Sitemap changes when news changes.
         * Keep cache short.
         */
        "Cache-Control":
          "public, max-age=120, s-maxage=300"
      }
    }
  );
}


/*
 * Create one sitemap entry.
 */
function createNewsUrl(
  article
) {

  const id =
    encodeURIComponent(
      String(article.id)
    );


  const headline =
    escapeXml(
      String(
        article.headline || "News"
      )
    );


  const publishedAt =
    new Date(
      article.published_at
    ).toISOString();


  return `  <url>
    <loc>${SITE_URL}/n/${id}</loc>
    <news:news>
      <news:publication>
        <news:name>Ajker News</news:name>
        <news:language>bn</news:language>
      </news:publication>
      <news:publication_date>${publishedAt}</news:publication_date>
      <news:title>${headline}</news:title>
    </news:news>
  </url>`;
}


/*
 * XML escaping.
 */
function escapeXml(
  value
) {

  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}


/*
 * Generate a normal sitemap index.
 *
 * This points Google to the dynamic
 * Google News sitemap.
 */
export function generateSitemapIndex() {

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
>
  <sitemap>
    <loc>${SITE_URL}/news-sitemap.xml</loc>
  </sitemap>
</sitemapindex>`;


  return new Response(
    xml,
    {
      status: 200,

      headers: {
        "Content-Type":
          "application/xml; charset=UTF-8",

        "Cache-Control":
          "public, max-age=300, s-maxage=600"
      }
    }
  );
}


/*
 * Generate robots.txt.
 *
 * Google and other search crawlers can discover
 * the sitemap from here.
 */
export function generateRobotsTxt() {

  const text = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;


  return new Response(
    text,
    {
      status: 200,

      headers: {
        "Content-Type":
          "text/plain; charset=UTF-8",

        "Cache-Control":
          "public, max-age=3600, s-maxage=3600"
      }
    }
  );
}