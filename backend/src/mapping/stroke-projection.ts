import type Database from 'better-sqlite3';
import type { StrokeIndex, DetailChunk } from './compact-contracts.js';
import { requireThat } from '../domain/errors.js';
import { readStrokes } from './stroke.js';

export function strokeIndex(db: Database.Database, projectId: string): { items: StrokeIndex[]; knownIds: string[] } {
  const identities = db.prepare('SELECT id FROM mapping_stroke_ids WHERE project_id=? ORDER BY rowid')
    .all(projectId) as { id: string }[];
  const creationOrder = new Map(identities.map((value, order) => [value.id, order]));
  const items = readStrokes(db, projectId).map((value): StrokeIndex => {
    const order = creationOrder.get(value.id);
    requireThat(order !== undefined, 'SNAPSHOT_UNAVAILABLE', '笔迹创建序位不可读取，请重新开始', 503);
    const { path, ...appearance } = value.content;
    return {
      id: value.id,
      type: 'stroke',
      versionId: value.versionId,
      order,
      item: value.item,
      content: { ...appearance, pointCount: path.length, availability: 'not_fetched' },
    };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, knownIds: identities.map(value => value.id) };
}

export function strokeDetail(db: Database.Database, projectId: string, value: StrokeIndex): DetailChunk[] {
  const row = db.prepare("SELECT value FROM mapping_versions WHERE project_id=? AND domain='stroke' AND id=? AND version_id=?")
    .get(projectId, value.id, value.versionId) as { value: string } | undefined;
  requireThat(row, 'SNAPSHOT_UNAVAILABLE', '固定笔迹版本不可读取，请重新开始', 503);
  const points = Array.from(row.value);
  const chunks: DetailChunk[] = [];
  for (let at = 0; at < points.length; at += 128)
    chunks.push({ id: value.id, chunkIndex: at / 128, chunkCount: Math.ceil(points.length / 128), jsonText: points.slice(at, at + 128).join('') });
  return chunks;
}
