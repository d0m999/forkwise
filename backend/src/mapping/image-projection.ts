import type Database from 'better-sqlite3';
import type { ImageIndex, DetailChunk } from './compact-contracts.js';
import { requireThat } from '../domain/errors.js';
import { readImages } from './image.js';

export function imageIndex(db: Database.Database, projectId: string): { items: ImageIndex[]; knownIds: string[] } {
  const identities = db.prepare('SELECT id FROM mapping_image_ids WHERE project_id=? ORDER BY rowid').all(projectId) as { id: string }[];
  const orders = new Map(identities.map((value, order) => [value.id, order]));
  return { knownIds: identities.map(value => value.id), items: readImages(db, projectId).map((value): ImageIndex => {
    const order = orders.get(value.id);
    requireThat(order !== undefined, 'SNAPSHOT_UNAVAILABLE', '图片创建序位不可读取，请重新开始', 503);
    return { id: value.id, type: 'image', versionId: value.versionId, order, item: value.item,
      content: { assetId: value.content.assetId, availability: 'not_fetched' } };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
export function imageDetail(db: Database.Database, projectId: string, value: ImageIndex): DetailChunk[] {
  const row = db.prepare("SELECT value FROM mapping_versions WHERE project_id=? AND domain='image' AND id=? AND version_id=?")
    .get(projectId, value.id, value.versionId) as { value: string } | undefined;
  requireThat(row, 'SNAPSHOT_UNAVAILABLE', '固定图片版本不可读取，请重新开始', 503);
  const points = Array.from(row.value), chunks: DetailChunk[] = [];
  for (let at = 0; at < points.length; at += 128)
    chunks.push({ id: value.id, chunkIndex: at / 128, chunkCount: Math.ceil(points.length / 128), jsonText: points.slice(at, at + 128).join('') });
  return chunks;
}
