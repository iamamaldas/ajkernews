// worker/src/database.js
// ✅ FIXED: unused getNews, unpublishNews, pruneTo1000 সরানো

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

export async function publishNews(db, id, data) {
  await db
    .prepare(`
      UPDATE news
      SET headline = ?, summary = ?, main_topic = ?, status = 'published', score = ?
      WHERE id = ?
    `)
    .bind(data.headline, data.summary, data.main_topic, data.score, id)
    .run();
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
