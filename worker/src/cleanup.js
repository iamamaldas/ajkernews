/*
 * News database cleanup — MAX 1000 published records
 * + 48h+ old candidates deleted
 * + 24h+ old rejected news deleted
 * Uses db.batch() for fast deletion
 */

const MAX_TOTAL_NEWS = 1000;
const MAX_DELETE_PER_RUN = 50;   // was 100 — safer to avoid sudden drops
const CANDIDATE_MAX_AGE_HOURS = 48;
const REJECTED_MAX_AGE_HOURS = 24;

export async function getNewsCount(db) {
  // Only count PUBLISHED news
  const result = await db.prepare(`SELECT COUNT(*) AS total FROM news WHERE status = 'published'`).first();
  return Number(result?.total || 0);
}

export async function getOldestNews(db, limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 200);

  // Only delete PUBLISHED news with valid created_at
  const result = await db
    .prepare(`
      SELECT id, source_url, status, created_at
      FROM news
      WHERE status = 'published'
        AND created_at IS NOT NULL
        AND created_at != ''
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
  const toDelete = Math.min(excess, MAX_DELETE_PER_RUN);
  const oldest = await getOldestNews(db, toDelete);

  if (oldest.length === 0) {
    return { total, deleted: 0, deletedIds: [] };
  }

  try {
    const statements = oldest.map(a => db.prepare(`DELETE FROM news WHERE id = ?`).bind(a.id));
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

export async function cleanOldCandidates(db) {
  try {
    const result = await db.prepare(`
      DELETE FROM news 
      WHERE status = 'candidate' 
        AND created_at <= datetime('now', '-${CANDIDATE_MAX_AGE_HOURS} hours')
    `).run();

    const deleted = Number(result?.meta?.changes || 0);
    if (deleted > 0) {
      console.log(`[CLEANUP] Deleted ${deleted} old candidates (${CANDIDATE_MAX_AGE_HOURS}h+)`);
    }
    return { deleted };
  } catch (error) {
    console.error("[CLEANUP] Candidate cleanup failed:", error?.message || String(error));
    return { deleted: 0 };
  }
}

export async function cleanRejectedNews(db) {
  try {
    const result = await db.prepare(`
      DELETE FROM news 
      WHERE status = 'rejected' 
        AND created_at <= datetime('now', '-${REJECTED_MAX_AGE_HOURS} hours')
    `).run();

    const deleted = Number(result?.meta?.changes || 0);
    if (deleted > 0) {
      console.log(`[CLEANUP] Deleted ${deleted} rejected news (${REJECTED_MAX_AGE_HOURS}h+)`);
    }
    return { deleted };
  } catch (error) {
    console.error("[CLEANUP] Rejected cleanup failed:", error?.message || String(error));
    return { deleted: 0 };
  }
}

export async function emergencyCleanup(db) {
  const result = await enforceNewsLimit(db);
  const candidateResult = await cleanOldCandidates(db);
  const rejectedResult = await cleanRejectedNews(db);
  console.log("Full cleanup completed:", { ...result, ...candidateResult, ...rejectedResult });
  return { ...result, candidateDeleted: candidateResult.deleted, rejectedDeleted: rejectedResult.deleted };
}

export { MAX_TOTAL_NEWS, CANDIDATE_MAX_AGE_HOURS, REJECTED_MAX_AGE_HOURS };
