/*
 * News database cleanup
 *
 * Rules:
 *
 * 1. Maximum stored records = 200
 * 2. Oldest records are removed first
 * 3. Published news is also eligible for deletion
 *    when the storage limit is exceeded
 * 4. Deleted article URLs are handled by index.js
 *    with HTTP 410 Gone
 */

const MAX_TOTAL_NEWS = 200;


/*
 * Get total number of stored news records.
 */
export async function getNewsCount(db) {

  const result =
    await db
      .prepare(`
        SELECT COUNT(*) AS total
        FROM news
      `)
      .first();

  return Number(
    result?.total || 0
  );
}


/*
 * Find the oldest news records.
 */
export async function getOldestNews(
  db,
  limit = 10
) {

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 10,
        1
      ),
      200
    );

  const result =
    await db
      .prepare(`
        SELECT
          id,
          source_url,
          status,
          created_at
        FROM news
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .bind(safeLimit)
      .all();

  return result.results || [];
}


/*
 * Delete one news record.
 */
export async function deleteNewsById(
  db,
  id
) {

  if (!id) {
    return false;
  }

  const result =
    await db
      .prepare(`
        DELETE FROM news
        WHERE id = ?
      `)
      .bind(id)
      .run();

  return (
    Number(
      result?.meta?.changes || 0
    ) > 0
  );
}


/*
 * Remove the oldest records until the database
 * contains no more than 200 records.
 */
export async function enforceNewsLimit(
  db
) {

  let total =
    await getNewsCount(db);

  let deleted = 0;

  const deletedIds = [];


  while (
    total > MAX_TOTAL_NEWS
  ) {

    /*
     * Delete in small batches instead of loading
     * the whole database.
     */
    const amountToDelete =
      Math.min(
        total - MAX_TOTAL_NEWS,
        10
      );


    const oldest =
      await getOldestNews(
        db,
        amountToDelete
      );


    if (
      oldest.length === 0
    ) {
      break;
    }


    for (
      const article of oldest
    ) {

      const success =
        await deleteNewsById(
          db,
          article.id
        );


      if (success) {

        deleted++;

        deletedIds.push(
          article.id
        );

        total--;
      }


      if (
        total <= MAX_TOTAL_NEWS
      ) {
        break;
      }
    }
  }


  return {

    total,

    deleted,

    deletedIds
  };
}


/*
 * Optional emergency cleanup.
 *
 * This can be called if the database ever
 * grows substantially above the expected limit.
 */
export async function emergencyCleanup(
  db
) {

  const result =
    await enforceNewsLimit(
      db
    );

  console.log(
    "News cleanup completed:",
    result
  );

  return result;
}


/*
 * Export configuration.
 */
export {
  MAX_TOTAL_NEWS
};