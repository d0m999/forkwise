import type Database from 'better-sqlite3';
import type { ShapeIndex, DetailChunk } from './compact-contracts.js';
import { requireThat } from '../domain/errors.js';
import { readShapes } from './shape.js';

export function shapeIndex(db: Database.Database, projectId: string): { items: ShapeIndex[]; knownIds: string[] } {
  const identities = db.prepare('SELECT id FROM mapping_shape_ids WHERE project_id=? ORDER BY rowid')
    .all(projectId) as { id: string }[];
  const creationOrder = new Map(identities.map((value, order) => [value.id, order]));
  const items = readShapes(db, projectId).map((value): ShapeIndex => {
    const order = creationOrder.get(value.id);
    requireThat(order !== undefined, 'SNAPSHOT_UNAVAILABLE', '形状创建序位不可读取，请重新开始', 503);
    const { shortText: _, ...appearance } = value.content;
    return {
      id: value.id,
      type: 'shape',
      versionId: value.versionId,
      order,
      item: value.item,
      content: { ...appearance, availability: 'not_fetched' },
    };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, knownIds: identities.map(value => value.id) };
}

export function shapeDetail(db: Database.Database, projectId: string, value: ShapeIndex): DetailChunk[] {
  const row = db.prepare("SELECT value FROM mapping_versions WHERE project_id=? AND domain='shape' AND id=? AND version_id=?")
    .get(projectId, value.id, value.versionId) as { value: string } | undefined;
  requireThat(row, 'SNAPSHOT_UNAVAILABLE', '固定形状版本不可读取，请重新开始', 503);
  const points = Array.from(row.value);
  const chunks: DetailChunk[] = [];
  for (let at = 0; at < points.length; at += 128)
    chunks.push({ id: value.id, chunkIndex: at / 128, chunkCount: Math.ceil(points.length / 128), jsonText: points.slice(at, at + 128).join('') });
  return chunks;
}
