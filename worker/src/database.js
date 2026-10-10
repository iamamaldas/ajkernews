// worker/src/database.js
// ✅ FIXED: Random Publish Time (Google Spam Pattern এড়ানোর জন্য)
// ✅ Google Indexing API Safe (disable করা কিন্তু ভবিষ্যতে চালু করা যাবে)

export async function getNewsById(db, id) {
  return await db.prepare(`SELECT * FROM news WHERE id = ? LIMIT 1`).bind(id).first();
}

export async function insertCandidate(db, article) {
  await db
    .prepare(`
      INSERT OR IGNORE INTO news (
        id, source_url, source_name, source_title, source_description,
        headline, summary, main_topic, category, language, image_url,
        published_at, created_at, day_key, status, score
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)
    `)
    .bind(
      article.id,
      article.source_url,
      article.source_name,
      article.source_title,
      article.source_description || "",
      article.headline || null,
      article.summary || null,
      article.main_topic || null,
      article.category || "general",
      article.language || "bn",
      article.image_url || null,
      article.published_at,
      article.created_at,
      article.day_key,
      article.score || 0
    )
    .run();
}

// ═══════════════════════════════════════════════════════════
// ✅ CRITICAL FIX: Random Publish Time
// ═══════════════════════════════════════════════════════════
// আগে: সব নিউজ একই সময়ে publish হতো (12:01:55, 12:01:54...)
// এখন: প্রতিটি নিউজ random সময়ে (0-110 minutes ago) publish হবে
// ফলাফল: Google স্বাভাবিক news flow দেখবে, Spam Pattern এড়াবে
// ═══════════════════════════════════════════════════════════
export async function publishNews(db, id, data) {
  // ✅ Automatic Random Publish Time (0-110 minutes ago)
  // Cron ২ ঘণ্টা (120 মিনিট) পর পর চলে, তাই 110 মিনিট = safe range
  const now = new Date();
  const randomMinutesAgo = Math.floor(Math.random() * 110);
  const randomTime = new Date(now.getTime() - randomMinutesAgo * 60 * 1000);
  const isoTimestamp = randomTime.toISOString();

  await db
    .prepare(`
      UPDATE news
      SET headline = ?, summary = ?, main_topic = ?, status = 'published', 
          score = ?, published_at = ?, created_at = ?
      WHERE id = ?
    `)
    .bind(
      data.headline,
      data.summary,
      data.main_topic,
      data.score,
      isoTimestamp,
      isoTimestamp,
      id
    )
    .run();

  console.log(`[PUBLISH] ${id} published at ${isoTimestamp} (random ${randomMinutesAgo}m ago)`);
}

export async function deleteNews(db, id) {
  await db.prepare(`DELETE FROM news WHERE id = ?`).bind(id).run();
}

export async function deleteOldestNews(db) {
  await db
    .prepare(`
      DELETE FROM news
      WHERE id IN (SELECT id FROM news ORDER BY created_at ASC LIMIT 1)
    `)
    .run();
}

export async function countNews(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM news`).first();
  return Number(row?.total || 0);
}
