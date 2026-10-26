import { requireConnectorEndpoint } from './connector-endpoints.js';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { CanvasConnector, ConnectorChange, ConnectorCommand } from './connector-contracts.js';

export function initializeConnectors(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_connectors(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mapping_connector_ids(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id));`);
}

export function readConnectors(db: Database.Database, projectId: string): CanvasConnector[] {
  const rows = db.prepare('SELECT c.value FROM mapping_connectors c JOIN mapping_connector_ids i ON i.id=c.id WHERE c.project_id=? ORDER BY i.rowid')
    .all(projectId) as { value: string }[];
  return rows.map(row => JSON.parse(row.value));
}

export function createConnector(db: Database.Database, command: Extract<ConnectorCommand, { type: 'connector.create' }>): CanvasConnector {
  const { projectId, payload } = command;
  requireThat(!db.prepare('SELECT 1 FROM mapping_connector_ids WHERE id=?').get(payload.id),
    'ID_CONFLICT', '身份已使用，请重新创建', 409);
  requireThat(payload.start.kind !== 'bound' || payload.end.kind !== 'bound' || payload.start.itemId !== payload.end.itemId,
    'INVALID_ENDPOINT', '普通连线不能将两端绑定到同一个对象', 400);
  requireThat(payload.start.kind !== 'free' || payload.end.kind !== 'free' ||
    payload.start.point.x !== payload.end.point.x || payload.start.point.y !== payload.end.point.y,
    'INVALID_ENDPOINT', '普通连线不能创建零长度连线', 400);
  requireConnectorEndpoint(db, projectId, payload.start);
  requireConnectorEndpoint(db, projectId, payload.end);
  const value: CanvasConnector = { ...payload, kind: 'connector', versionId: randomUUID() };
  db.prepare('INSERT INTO mapping_connector_ids VALUES(?,?)').run(value.id, projectId);
  saveConnector(db, projectId, value);
  return value;
}

export function reconnectConnector(db: Database.Database, command: Extract<ConnectorCommand, { type: 'connector.reconnect' }>): ConnectorChange | null {
  const before = requireConnector(db, command);
  const after = structuredClone(before);
  after[command.payload.endpoint] = command.payload.value;
  requireThat(after.start.kind !== 'bound' || after.end.kind !== 'bound' || after.start.itemId !== after.end.itemId,
    'INVALID_ENDPOINT', '普通连线不能将两端绑定到同一个对象', 400);
  requireConnectorEndpoint(db, command.projectId, after.start);
  requireConnectorEndpoint(db, command.projectId, after.end);
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  after.versionId = randomUUID();
  saveConnector(db, command.projectId, after);
  return { before, after };
}

export function changeConnectorPath(db: Database.Database, command: Extract<ConnectorCommand, { type: 'connector.path' }>): ConnectorChange | null {
  const before = requireConnector(db, command);
  if (before.path === command.payload.path) return null;
  const after = { ...before, path: command.payload.path, versionId: randomUUID() };
  saveConnector(db, command.projectId, after);
  return { before, after };
}

export function moveConnector(db: Database.Database, command: Extract<ConnectorCommand, { type: 'connector.move' }>): ConnectorChange | null {
  const before = requireConnector(db, command);
  const translate = (endpoint: CanvasConnector['start']): CanvasConnector['start'] => {
    if (endpoint.kind === 'bound') return endpoint;
    const point = { x: endpoint.point.x + command.payload.dx, y: endpoint.point.y + command.payload.dy };
    requireThat(Number.isFinite(point.x) && Number.isFinite(point.y), 'INVALID_GEOMETRY', '自由端位置超出有效坐标范围', 400);
    return { kind: 'free', point };
  };
  const after = { ...before, start: translate(before.start), end: translate(before.end) };
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  after.versionId = randomUUID();
  saveConnector(db, command.projectId, after);
  return { before, after };
}

export function deleteConnector(db: Database.Database, command: Extract<ConnectorCommand, { type: 'connector.delete' }>): ConnectorChange {
  const before = requireConnector(db, command);
  db.prepare('DELETE FROM mapping_connectors WHERE id=? AND project_id=?').run(before.id, command.projectId);
  return { before, after: null };
}

export function prepareIncidentConnectorDeletion(db: Database.Database, projectId: string, itemId: string, expected: Record<string, string>): ConnectorChange[] {
  const incident = readConnectors(db, projectId).filter(value =>
    value.start.kind === 'bound' && value.start.itemId === itemId ||
    value.end.kind === 'bound' && value.end.itemId === itemId);
  requireThat(Object.keys(expected).length === incident.length && incident.every(value =>
    Object.hasOwn(expected, value.id) && expected[value.id] === value.versionId),
  'VERSION_CONFLICT', '相连连线范围或版本已更新，请重新读取', 409);
  return incident.map(before => ({ before, after: null }));
}

export function applyIncidentConnectorDeletion(db: Database.Database, projectId: string, changes: ConnectorChange[]) {
  for (const change of changes) {
    const deleted = db.prepare('DELETE FROM mapping_connectors WHERE id=? AND project_id=?').run(change.before!.id, projectId);
    requireThat(deleted.changes === 1, 'VERSION_CONFLICT', '相连连线范围已更新，请重新读取', 409);
  }
}

export function restoreConnector(
  db: Database.Database,
  projectId: string,
  change: ConnectorChange,
  type: 'history.undo' | 'history.redo',
): ConnectorChange {
  const desired = type === 'history.undo' ? change.before : change.after;
  const identity = change.after ?? change.before!;
  const before = readConnectors(db, projectId).find(value => value.id === identity.id) ?? null;
  const after = desired ? { ...structuredClone(desired), versionId: randomUUID() } : null;
  if (after) saveConnector(db, projectId, after);
  else db.prepare('DELETE FROM mapping_connectors WHERE id=? AND project_id=?').run(identity.id, projectId);
  return { before, after };
}

function requireConnector(db: Database.Database, command: Exclude<ConnectorCommand, { type: 'connector.create' }>): CanvasConnector {
  const row = db.prepare('SELECT c.value FROM mapping_connectors c JOIN mapping_connector_ids i ON i.id=c.id WHERE c.project_id=? AND c.id=?')
    .get(command.projectId, command.payload.id) as { value: string } | undefined;
  requireThat(row, 'NOT_FOUND', '连线不存在于当前项目', 404);
  const before: CanvasConnector = JSON.parse(row.value);
  requireThat(before.versionId === command.expected, 'VERSION_CONFLICT', '连线已更新，请重新读取', 409);
  return before;
}

function saveConnector(db: Database.Database, projectId: string, value: CanvasConnector) {
  db.prepare('INSERT INTO mapping_connectors VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
    .run(value.id, projectId, JSON.stringify(value));
  db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)')
    .run(projectId, 'connector', value.id, value.versionId, JSON.stringify(value));
}
