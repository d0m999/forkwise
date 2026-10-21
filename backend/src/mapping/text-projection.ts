import type Database from 'better-sqlite3';
import type { TextIndex, DetailChunk } from './compact-contracts.js';
import { requireThat } from '../domain/errors.js';
import { readTexts } from './text.js';
export function textIndex(db: Database.Database, projectId: string): TextIndex[] {
  const identities = db
    .prepare('SELECT id FROM mapping_text_ids WHERE project_id=? ORDER BY rowid')
    .all(projectId) as { id: string }[];
  const creationOrder = new Map(identities.map((value, order) => [value.id, order]));
  return readTexts(db, projectId).map((value): TextIndex => {
    const order = creationOrder.get(value.id);
    requireThat(order !== undefined, 'SNAPSHOT_UNAVAILABLE', '文字创建序位不可读取，请重新开始', 503);
    const { runs, ...style } = value.content;
    return {
      id: value.id,
      type: 'text',
      versionId: value.versionId,
      order,
      item: value.item,
      content: { ...style, runCount: runs.length, availability: 'not_fetched' },
    };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function textDetail(
  db: Database.Database,
  projectId: string,
  value: TextIndex,
): DetailChunk[] {
  const row = db
    .prepare(
      "SELECT value FROM mapping_versions WHERE project_id=? AND domain='text' AND id=? AND version_id=?",
    )
    .get(projectId, value.id, value.versionId) as { value: string } | undefined;
  requireThat(row, 'SNAPSHOT_UNAVAILABLE', '固定文字版本不可读取，请重新开始', 503);
  const points = Array.from(row.value);
  const chunks: DetailChunk[] = [];
  for (let at = 0; at < points.length; at += 128)
    chunks.push({
      id: value.id,
      chunkIndex: at / 128,
      chunkCount: Math.ceil(points.length / 128),
      jsonText: points.slice(at, at + 128).join(''),
    });
  return chunks;
}
