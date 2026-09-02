export async function getNews(
  db,
  category = "top",
  limit = 25
) {

  const safeLimit = Math.min(
    Math.max(Number(limit) || 25, 1),
    25
  );

  let sql;
  let bindings = [];

  if (category === "trending") {

    sql = `
      SELECT
        id,
        headline,
        summary,
        main_topic,
        category,
        image_url,
        source_name,
        source_url,
        published_at,
        created_at
      FROM news
      WHERE status = 'published'
      ORDER BY score DESC, published_at DESC
      LIMIT ?
    `;

    bindings = [safeLimit];

  } else if (category === "all") {

    sql = `
      SELECT
        id,
        headline,
        summary,
        main_topic,
        category,
        image_url,
        source_name,
        source_url,
        published_at,
        created_at
      FROM news
      WHERE status = 'published'
      ORDER BY published_at DESC
      LIMIT ?
    `;

    bindings = [safeLimit];

  } else {

    sql = `
      SELECT
        id,
        headline,
        summary,
        main_topic,
        category,
        image_url,
        source_name,
        source_url,
        published_at,
        created_at
      FROM news
      WHERE status = 'published'
      ORDER BY score DESC, published_at DESC
      LIMIT ?
    `;

    bindings = [safeLimit];
  }

  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .all();

  return result.results || [];
}


export async function getNewsById(db, id) {

  return await db
    .prepare(`
      SELECT *
      FROM news
      WHERE id = ?
      LIMIT 1
    `)
    .bind(id)
    .first();
}


export async function insertCandidate(db, article) {

  await db
    .prepare(`
      INSERT OR IGNORE INTO news (
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
        score
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)
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
      article.category,
      article.image_url || null,
      article.published_at,
      article.created_at,
      article.day_key,
      article.score || 0
    )
    .run();
}


export async function publishNews(
  db,
  id,
  data
) {

  await db
    .prepare(`
      UPDATE news
      SET
        headline = ?,
        summary = ?,
        main_topic = ?,
        status = 'published',
        score = ?
      WHERE id = ?
    `)
    .bind(
      data.headline,
      data.summary,
      data.main_topic,
      data.score,
      id
    )
    .run();
}


export async function unpublishNews(db, id) {

  await db
    .prepare(`
      UPDATE news
      SET
        status = 'candidate'
      WHERE id = ?
    `)
    .bind(id)
    .run();
}


export async function deleteNews(db, id) {

  await db
    .prepare(`
      DELETE FROM news
      WHERE id = ?
    `)
    .bind(id)
    .run();
}


export async function deleteOldestNews(db) {

  await db
    .prepare(`
      DELETE FROM news
      WHERE id IN (
        SELECT id
        FROM news
        ORDER BY created_at ASC
        LIMIT 1
      )
    `)
    .run();
}


export async function countNews(db) {

  const row = await db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM news
    `)
    .first();

  return Number(row?.total || 0);
}


// আপডেট করা হয়েছে: 100 থেকে 200 করা হয়েছে (index.js ও cleanup.js-এর সাথে মিলিয়ে)
export async function pruneTo200(db) {

  let total = await countNews(db);

  while (total > 200) {

    await deleteOldestNews(db);

    total--;
  }

  return total;
}