import type Database from 'better-sqlite3';

// A single ordinal across every canvas item keeps new content above anything
// that a previous layer operation renumbered to a compact range.
export function nextCreatedOrder(db: Database.Database, projectId: string, revision: number) {
  const row = db
    .prepare(
      `SELECT MAX(created) AS created FROM (
        SELECT json_extract(value,'$.item.createdOrder') AS created FROM mapping_cards WHERE project_id=?
        UNION ALL SELECT json_extract(value,'$.item.createdOrder') FROM mapping_texts WHERE project_id=?
        UNION ALL SELECT json_extract(value,'$.item.createdOrder') FROM mapping_shapes WHERE project_id=?
        UNION ALL SELECT json_extract(value,'$.item.createdOrder') FROM mapping_images WHERE project_id=?
        UNION ALL SELECT json_extract(value,'$.item.createdOrder') FROM mapping_strokes WHERE project_id=?
      )`,
    )
    .get(projectId, projectId, projectId, projectId, projectId) as { created: number | null };
  return Math.max(Number(row?.created ?? 0) || 0, revision) + 1;
}
