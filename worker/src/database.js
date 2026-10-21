// worker/src/database.js

export async function getNewsById(db, id) {
  return await db.prepare(`SELECT * FROM news WHERE id = ? LIMIT 1`).bind(id).first();
}

export async function insertCandidate(db, article) {
  await db
    .prepare(`
      INSERT OR IGNORE INTO news (
        id, source_url, source_name, source_title, source_description,
        headline, summary, main_topic, category, language, image_url,
        published_at, created_at, day_key, status, score, type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, 'news')
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
  const isoTimestamp = new Date().toISOString();
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
  console.log(`[PUBLISH] ${id} published at ${isoTimestamp}`);
}

export async function deleteNews(db, id) {
  await db.prepare(`DELETE FROM news WHERE id = ?`).bind(id).run();
}

export async function deleteOldestNews(db) {
  await db.prepare(`DELETE FROM news WHERE id IN (SELECT id FROM news ORDER BY created_at ASC LIMIT 1)`).run();
}

export async function countNews(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM news`).first();
  return Number(row?.total || 0);
}

// ✅ NEW: Quiz functions
export async function insertDailyQuiz(db, quizData) {
  const id = quizData.id || crypto.randomUUID();
  const isoTimestamp = new Date().toISOString();
  const dayKey = quizData.date || new Date().toISOString().slice(0, 10);
  const headline = quizData.title || "আজকের কুইজ";

  await db.prepare(`
    INSERT OR REPLACE INTO news (
      id, source_url, source_name, source_title, source_description,
      headline, summary, main_topic, category, language, image_url,
      published_at, created_at, day_key, status, score, type, quiz_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, 'quiz', ?)
  `).bind(
    id,
    `https://ajkernews.in/quiz/${dayKey}`,
    "Ajker News Quiz",
    headline,
    headline,
    headline,
    "আজকের কুইজে অংশ নিন এবং আপনার জ্ঞান পরীক্ষা করুন।",
    "Quiz",
    "quiz",
    "bn",
    "https://ajkernews.in/logo.png",
    isoTimestamp,
    isoTimestamp,
    dayKey,
    50,
    JSON.stringify(quizData.questions)
  ).run();

  return id;
}

export async function getQuizByDate(db, date) {
  return await db.prepare(`
    SELECT * FROM news 
    WHERE type = 'quiz' AND day_key = ? AND status = 'published' 
    LIMIT 1
  `).bind(date).first();
}
