import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { requireThat } from '../domain/errors.js';
import type { CanvasStroke, StrokeChange, StrokeCreateCommand, StrokeDeleteCommand } from './stroke-contracts.js';
import { nextCreatedOrder } from './created-order.js';

export function initializeStrokes(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_strokes(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mapping_stroke_ids(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id));
    INSERT OR IGNORE INTO mapping_stroke_ids SELECT id,project_id FROM mapping_strokes ORDER BY rowid;`);
}

export function readStrokes(db: Database.Database, projectId: string): CanvasStroke[] {
  const rows = db.prepare('SELECT value FROM mapping_strokes WHERE project_id=? ORDER BY rowid')
    .all(projectId) as { value: string }[];
  return rows.map(row => JSON.parse(row.value));
}

export function createStroke(db: Database.Database, command: z.infer<typeof StrokeCreateCommand>): CanvasStroke {
  const { projectId, payload } = command;
  requireThat(!db.prepare('SELECT 1 FROM mapping_stroke_ids WHERE id=?').get(payload.id),
    'ID_CONFLICT', '身份已使用，请重新创建', 409);
  const project = db.prepare('SELECT revision FROM mapping_projects WHERE id=?').get(projectId) as { revision: number };
  const value: CanvasStroke = {
    id: payload.id, kind: 'stroke', versionId: randomUUID(), content: payload.content,
    item: { id: randomUUID(), versionId: randomUUID(), createdOrder: nextCreatedOrder(db, projectId, project.revision), pose: payload.pose },
  };
  db.prepare('INSERT INTO mapping_stroke_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_strokes VALUES(?,?,?)').run(value.id, projectId, JSON.stringify(value));
  retainStrokeVersions(db, projectId, value);
  return value;
}

export function deleteStroke(db: Database.Database, command: z.infer<typeof StrokeDeleteCommand>): StrokeChange {
  const before = readStrokes(db, command.projectId).find(stroke => stroke.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '笔迹不存在于当前项目', 404);
  requireThat(command.expected.stroke === before.versionId && command.expected.pose === before.item.versionId,
    'VERSION_CONFLICT', '删除依据已更新，请重新读取', 409);
  retainStrokeVersions(db, command.projectId, before);
  db.prepare('DELETE FROM mapping_strokes WHERE id=? AND project_id=?').run(before.id, command.projectId);
  return { before, after: null };
}

// The canvas operation already validated this typed member and its Pose version.
export function moveStroke(db: Database.Database, projectId: string, before: CanvasStroke, point: { x: number; y: number }): StrokeChange {
  const after = { ...before, item: { ...before.item, versionId: randomUUID(), pose: { ...before.item.pose, ...point } } };
  db.prepare('UPDATE mapping_strokes SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(after), after.id, projectId);
  retainStrokeVersions(db, projectId, after);
  return { before, after };
}

export function restoreStroke(
  db: Database.Database,
  projectId: string,
  change: StrokeChange,
  type: 'history.undo' | 'history.redo',
): StrokeChange {
  const desired = type === 'history.undo' ? change.before : change.after;
  const identity = change.after ?? change.before!;
  const before = readStrokes(db, projectId).find(stroke => stroke.id === identity.id) ?? null;
  const after = desired ? structuredClone(desired) : null;
  if (after) {
    const poseOnly = change.before && change.after && change.before.versionId === change.after.versionId && before;
    after.versionId = poseOnly ? before.versionId : randomUUID();
    if (poseOnly) after.content = before.content;
    after.item.versionId = randomUUID();
    db.prepare('INSERT OR IGNORE INTO mapping_stroke_ids VALUES(?,?)').run(after.id, projectId);
    db.prepare('INSERT INTO mapping_strokes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(after.id, projectId, JSON.stringify(after));
    retainStrokeVersions(db, projectId, after);
  } else db.prepare('DELETE FROM mapping_strokes WHERE id=? AND project_id=?').run(identity.id, projectId);
  return { before, after };
}

function retainStrokeVersions(db: Database.Database, projectId: string, stroke: CanvasStroke) {
  const insert = db.prepare('INSERT OR IGNORE INTO mapping_versions(project_id,domain,id,version_id,value) VALUES(?,?,?,?,?)');
  insert.run(projectId, 'stroke', stroke.id, stroke.versionId,
    JSON.stringify({ id: stroke.id, versionId: stroke.versionId, content: stroke.content }));
  insert.run(projectId, 'pose', stroke.item.id, stroke.item.versionId, JSON.stringify(stroke.item));
}
