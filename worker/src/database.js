// worker/src/database.js
// ✅ ADDED: Daily Quiz Insert & Retrieve functions
// ✅ Google Spam Pattern এড়ানোর জন্য Random Publish Time

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
// ✅ QUIZ FUNCTIONS (NEW)
// ═══════════════════════════════════════════════════════════
export async function insertDailyQuiz(db, data) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  
  await db.prepare(`
    INSERT INTO news (
      id, source_url, source_name, source_title, 
      headline, summary, category, image_url, 
      published_at, created_at, day_key, status, 
      type, quiz_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 'quiz', ?)
  `).bind(
    id,
    `https://ajkernews.in/quiz/${data.date}`,
    'Ajker News',
    data.title,
    data.title,
    'আজকের কুইজে অংশ নিন এবং আপনার জ্ঞান পরীক্ষা করুন। ১৫টি প্রশ্ন, ৩০ সেকেন্ড টাইমার।',
    'quiz',
    '/logo.png',
    now,
    now,
    data.date,
    JSON.stringify(data.questions)
  ).run();
}

export async function getQuizByDate(db, dateStr) {
  return await db.prepare(
    `SELECT * FROM news WHERE type = 'quiz' AND day_key = ? LIMIT 1`
  ).bind(dateStr).first();
}

// ═══════════════════════════════════════════════════════════
// ✅ CRITICAL FIX: Random Publish Time
// ═══════════════════════════════════════════════════════════
export async function publishNews(db, id, data) {
  // Random time between 0-110 minutes ago
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
