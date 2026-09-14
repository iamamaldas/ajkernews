/*
 * News database cleanup — MAX 1000 records (Free Tier Safe)
 * Uses db.batch() for fast deletion
 */

const MAX_TOTAL_NEWS = 1000;
const BATCH_DELETE_SIZE = 100;

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

  if (total <= MAX_TOTAL_NEWS) {
    return { total, deleted: 0, deletedIds: [] };
  }

  const excess = total - MAX_TOTAL_NEWS;
  const toDelete = Math.min(excess, BATCH_DELETE_SIZE);
  const oldest = await getOldestNews(db, toDelete);

  if (oldest.length === 0) {
    return { total, deleted: 0, deletedIds: [] };
  }

  // ✅ Batch delete — একসাথে ১০০টি
  try {
    const statements = oldest.map(a =>
      db.prepare(`DELETE FROM news WHERE id = ?`).bind(a.id)
    );
    const results = await db.batch(statements);

    for (let i = 0; i < results.length; i++) {
      if (Number(results[i]?.meta?.changes || 0) > 0) {
        deleted++;
        deletedIds.push(oldest[i].id);
      }
    }

    total -= deleted;
  } catch (error) {
    console.error("[CLEANUP] Batch delete failed:", error?.message || String(error));
  }

  return { total, deleted, deletedIds };
}

export async function emergencyCleanup(db) {
  const result = await enforceNewsLimit(db);
  console.log("News cleanup completed:", result);
  return result;
}

export { MAX_TOTAL_NEWS };
