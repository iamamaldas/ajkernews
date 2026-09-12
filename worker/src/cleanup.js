/*
 * News database cleanup — MAX 1000 records
 */

const MAX_TOTAL_NEWS = 1000;

export async function getNewsCount(db) {
  const result = await db.prepare(`SELECT COUNT(*) AS total FROM news`).first();
  return Number(result?.total || 0);
}

export async function getOldestNews(db, limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 200);

  const result = await db
    .prepare(`
      SELECT id, source_url, status, created_at
      FROM news
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .bind(safeLimit)
    .all();

  return result.results || [];
}

export async function deleteNewsById(db, id) {
  if (!id) return false;

  const result = await db.prepare(`DELETE FROM news WHERE id = ?`).bind(id).run();
  return Number(result?.meta?.changes || 0) > 0;
}

export async function enforceNewsLimit(db) {
  let total = await getNewsCount(db);
  let deleted = 0;
  const deletedIds = [];

  while (total > MAX_TOTAL_NEWS) {
    const amountToDelete = Math.min(total - MAX_TOTAL_NEWS, 10);
    const oldest = await getOldestNews(db, amountToDelete);

    if (oldest.length === 0) break;

    for (const article of oldest) {
      const success = await deleteNewsById(db, article.id);

      if (success) {
        deleted++;
        deletedIds.push(article.id);
        total--;
      }

      if (total <= MAX_TOTAL_NEWS) break;
    }
  }

  return { total, deleted, deletedIds };
}

export async function emergencyCleanup(db) {
  const result = await enforceNewsLimit(db);
  console.log("News cleanup completed:", result);
  return result;
}

export { MAX_TOTAL_NEWS };
