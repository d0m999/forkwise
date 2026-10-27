import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ConnectorIndex, DetailChunk } from './compact-contracts.js';
import { readConnectors } from './connector.js';
import { requireThat } from '../domain/errors.js';

export function connectorIndex(db: Database.Database, projectId: string): { items: ConnectorIndex[]; knownIds: string[] } {
  const identities = db.prepare('SELECT id FROM mapping_connector_ids WHERE project_id=? ORDER BY rowid').all(projectId) as { id: string }[];
  const order = new Map(identities.map((value, index) => [value.id, index]));
  const items = readConnectors(db, projectId).map((value): ConnectorIndex => {
    const ordinal = order.get(value.id);
    requireThat(ordinal !== undefined, 'SNAPSHOT_UNAVAILABLE', '连线创建序位不可读取，请重新开始', 503);
    const { kind: _, label, ...geometry } = value;
    const index: ConnectorIndex = { ...geometry, type: 'connector', order: ordinal };
    if (label !== undefined) {
      if (label === null) index.label = null;
      else {
        const { text, ...appearance } = label;
        index.label = { ...appearance, availability: 'not_fetched', textCodePoints: Array.from(text).length,
          textJsonSha256: createHash('sha256').update(JSON.stringify(text)).digest('hex') };
      }
    }
    return index;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { items, knownIds: identities.map(value => value.id) };
}

export function connectorDetail(db: Database.Database, projectId: string, value: ConnectorIndex): DetailChunk[] {
  const row = db.prepare("SELECT value FROM mapping_versions WHERE project_id=? AND domain='connector' AND id=? AND version_id=?").get(projectId, value.id, value.versionId) as { value: string } | undefined;
  requireThat(row, 'SNAPSHOT_UNAVAILABLE', '固定连线版本不可读取，请重新开始', 503);
  const points = Array.from(row.value), chunks: DetailChunk[] = [];
  for (let at = 0; at < points.length; at += 128)
    chunks.push({ id: value.id, chunkIndex: at / 128, chunkCount: Math.ceil(points.length / 128), jsonText: points.slice(at, at + 128).join('') });
  return chunks;
}
