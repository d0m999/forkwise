import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { CanvasShape, ShapeChange, ShapeCommand } from './shape-contracts.js';
import { nextCreatedOrder } from './created-order.js';

export function initializeShapes(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_shapes(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mapping_shape_ids(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id));
    INSERT OR IGNORE INTO mapping_shape_ids SELECT id,project_id FROM mapping_shapes ORDER BY rowid;`);
}

export function readShapes(db: Database.Database, projectId: string): CanvasShape[] {
  const rows = db.prepare('SELECT value FROM mapping_shapes WHERE project_id=? ORDER BY rowid')
    .all(projectId) as { value: string }[];
  return rows.map(row => JSON.parse(row.value));
}

export function createShape(db: Database.Database, command: Extract<ShapeCommand, { type: 'shape.create' }>): CanvasShape {
  const { projectId, payload } = command;
  requireThat(!db.prepare('SELECT 1 FROM mapping_shape_ids WHERE id=?').get(payload.id),
    'ID_CONFLICT', '身份已使用，请重新创建', 409);
  const project = db.prepare('SELECT revision FROM mapping_projects WHERE id=?').get(projectId) as { revision: number };
  const value: CanvasShape = {
    id: payload.id,
    kind: 'shape',
    versionId: randomUUID(),
    content: payload.content,
    item: { id: randomUUID(), versionId: randomUUID(), createdOrder: nextCreatedOrder(db, projectId, project.revision), pose: payload.pose },
  };
  db.prepare('INSERT INTO mapping_shape_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_shapes VALUES(?,?,?)').run(value.id, projectId, JSON.stringify(value));
  retainShapeVersions(db, projectId, value);
  return value;
}

export function editShape(db: Database.Database, command: Extract<ShapeCommand, { type: 'shape.edit' }>): ShapeChange | null {
  const before = readShapes(db, command.projectId).find(shape => shape.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '形状不存在于当前项目', 404);
  requireThat(command.expected === before.versionId, 'VERSION_CONFLICT', '形状已更新，请重新读取', 409);
  if (JSON.stringify(before.content) === JSON.stringify(command.payload.content)) return null;
  const after = structuredClone(before);
  after.content = command.payload.content;
  after.versionId = randomUUID();
  db.prepare('UPDATE mapping_shapes SET value=? WHERE id=? AND project_id=?')
    .run(JSON.stringify(after), after.id, command.projectId);
  retainShapeVersions(db, command.projectId, after);
  return { before, after };
}

export function moveShape(db: Database.Database, command: Extract<ShapeCommand, { type: 'shape.move' }>): ShapeChange | null {
  const before = readShapes(db, command.projectId).find(shape => shape.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '形状不存在于当前项目', 404);
  requireThat(command.expected === before.item.versionId, 'VERSION_CONFLICT', '布局已更新，请重新读取', 409);
  if (before.item.pose.x === command.payload.x && before.item.pose.y === command.payload.y) return null;
  const after = structuredClone(before);
  after.item = { ...after.item, versionId: randomUUID(), pose: { ...after.item.pose, x: command.payload.x, y: command.payload.y } };
  db.prepare('UPDATE mapping_shapes SET value=? WHERE id=? AND project_id=?')
    .run(JSON.stringify(after), after.id, command.projectId);
  retainShapeVersions(db, command.projectId, after);
  return { before, after };
}

export function deleteShape(db: Database.Database, command: Extract<ShapeCommand, { type: 'shape.delete' }>): ShapeChange {
  const before = readShapes(db, command.projectId).find(shape => shape.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '形状不存在于当前项目', 404);
  requireThat(command.expected.shape === before.versionId && command.expected.pose === before.item.versionId,
    'VERSION_CONFLICT', '删除依据已更新，请重新读取', 409);
  retainShapeVersions(db, command.projectId, before);
  db.prepare('DELETE FROM mapping_shapes WHERE id=? AND project_id=?').run(before.id, command.projectId);
  return { before, after: null };
}

export function transformShape(db: Database.Database, command: Extract<ShapeCommand, { type: 'shape.transform' }>): ShapeChange | null {
  const before = readShapes(db, command.projectId).find(shape => shape.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '形状不存在于当前项目', 404);
  requireThat(command.expected === before.item.versionId, 'VERSION_CONFLICT', '布局已更新，请重新读取', 409);
  const pose = command.payload.pose;
  if (before.item.pose.x === pose.x && before.item.pose.y === pose.y && before.item.pose.width === pose.width && before.item.pose.height === pose.height) return null;
  const after = structuredClone(before);
  after.item = { ...after.item, versionId: randomUUID(), pose };
  db.prepare('UPDATE mapping_shapes SET value=? WHERE id=? AND project_id=?')
    .run(JSON.stringify(after), after.id, command.projectId);
  retainShapeVersions(db, command.projectId, after);
  return { before, after };
}

export function restoreShape(
  db: Database.Database,
  projectId: string,
  change: ShapeChange,
  type: 'history.undo' | 'history.redo',
): ShapeChange {
  const desired = type === 'history.undo' ? change.before : change.after;
  const identity = change.after ?? change.before!;
  const before = readShapes(db, projectId).find(shape => shape.id === identity.id) ?? null;
  const after = desired ? structuredClone(desired) : null;
  if (after) {
    if (before && change.before && change.after && change.before.versionId === change.after.versionId) {
      after.content = before.content;
      after.versionId = before.versionId;
    } else after.versionId = randomUUID();
    if (before && change.before && change.after && change.before.item.versionId === change.after.item.versionId)
      after.item = before.item;
    else after.item.versionId = randomUUID();
    db.prepare('INSERT OR IGNORE INTO mapping_shape_ids VALUES(?,?)').run(after.id, projectId);
    db.prepare('INSERT INTO mapping_shapes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(after.id, projectId, JSON.stringify(after));
    retainShapeVersions(db, projectId, after);
  } else db.prepare('DELETE FROM mapping_shapes WHERE id=? AND project_id=?').run(identity.id, projectId);
  return { before, after };
}

function retainShapeVersions(db: Database.Database, projectId: string, shape: CanvasShape) {
  const insert = db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)');
  insert.run(projectId, 'shape', shape.id, shape.versionId,
    JSON.stringify({ id: shape.id, versionId: shape.versionId, content: shape.content }));
  insert.run(projectId, 'pose', shape.item.id, shape.item.versionId, JSON.stringify(shape.item));
}
