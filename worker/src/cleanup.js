/*
 * News database cleanup — MAX 1000 published records
 * + 48h+ old candidates deleted
 * + 24h+ old rejected news deleted
 * Uses db.batch() for fast deletion
 * v2 — Increased delete limit for faster cleanup
 */

const MAX_TOTAL_NEWS = 1000;
const MAX_DELETE_PER_RUN = 150;   // ✅ Increased from 50 to 150
const CANDIDATE_MAX_AGE_HOURS = 48;
const REJECTED_MAX_AGE_HOURS = 24;

export async function getNewsCount(db) {
  // Only count PUBLISHED news
  const result = await db.prepare(`SELECT COUNT(*) AS total FROM news WHERE status = 'published'`).first();
  return Number(result?.total || 0);
}

export async function getOldestNews(db, limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 500);

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
    // ✅ Batch delete in chunks of 50 to avoid hitting D1 limits
    const CHUNK_SIZE = 50;
    for (let i = 0; i < oldest.length; i += CHUNK_SIZE) {
      const chunk = oldest.slice(i, i + CHUNK_SIZE);
      const statements = chunk.map(a => db.prepare(`DELETE FROM news WHERE id = ?`).bind(a.id));
      const results = await db.batch(statements);

      for (let j = 0; j < results.length; j++) {
        if (Number(results[j]?.meta?.changes || 0) > 0) {
          deleted++;
          deletedIds.push(chunk[j].id);
        }
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
