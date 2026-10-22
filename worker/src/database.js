// worker/src/database.js
// ✅ FIXED: Dynamic SEO Title & Meta based on Daily Trending Keyword

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
// ✅ QUIZ FUNCTIONS (SEO Optimized - No "আজকের কুইজ")
// ═══════════════════════════════════════════════════════════
export async function insertDailyQuiz(db, data) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  
  const quizImage = "https://images.unsplash.com/photo-1606326608606-aa0b62935f2b?auto=format&fit=crop&w=800&q=80";

  // ✅ Extract the Top Search Keyword from the first question
  let trendingKeyword = "";
  if (data.questions && data.questions.length > 0 && data.questions[0].mainTopic) {
      trendingKeyword = data.questions[0].mainTopic;
  }

  // ✅ Format Date from "আজকের কুইজ: ২২ অক্টোবর ২০২৬" -> "২২ অক্টোবর ২০২৬"
  let datePart = data.title.replace("আজকের কুইজ:", "").trim();

  // ✅ Dynamic SEO Title
  let dynamicTitle = `${datePart} কারেন্ট অ্যাফেয়ার্স: ${trendingKeyword || 'সাধারণ জ্ঞান'} | সাধারণ জ্ঞান ২০২৬`;

  // ✅ Dynamic Meta Description
  const dynamicDescription = `${datePart} কারেন্ট অ্যাফেয়ার্স ও সাধারণ জ্ঞান কুইজে অংশ নিন। ${trendingKeyword ? trendingKeyword + ' ' : ''}সংক্রান্ত ১২টি প্রশ্ন, ৩০ সেকেন্ড টাইমার। ২০২৬ সালের গুরুত্বপূর্ণ প্রশ্নোত্তর।`;

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
    dynamicTitle, // ✅ SEO Title
    dynamicTitle, // ✅ Headline
    dynamicDescription, // ✅ Meta Description
    'quiz',
    quizImage, 
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
// ✅ YOUR ORIGINAL LOGIC: Random Publish Time
// ═══════════════════════════════════════════════════════════
export async function publishNews(db, id, data) {
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
