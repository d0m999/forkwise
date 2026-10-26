import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';
import type { ConnectorEndpoint } from './connector-contracts.js';

const targetTables = ['mapping_cards', 'mapping_shapes', 'mapping_texts', 'mapping_images'];

export function requireConnectorEndpoint(db: Database.Database, projectId: string, endpoint: ConnectorEndpoint) {
  if (endpoint.kind === 'free') return;
  const target = targetTables.some(table => db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND json_extract(value,'$.item.id')=?`)
    .get(projectId, endpoint.itemId));
  requireThat(target, 'INVALID_ENDPOINT', '连线端点必须是当前项目有效的可连接画布项', 400);
}
