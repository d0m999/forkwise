import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import { readAsset } from './media.js';
import type { CanvasImage, ImageCommand, ImageChange } from './image-contracts.js';

export function initializeImages(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_images(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mapping_image_ids(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id));`);
}
export function readImages(db: Database.Database, projectId: string): CanvasImage[] {
  return (db.prepare('SELECT value FROM mapping_images WHERE project_id=? ORDER BY rowid').all(projectId) as { value: string }[])
    .map(row => JSON.parse(row.value));
}
export function createImage(db: Database.Database, command: Extract<ImageCommand, { type: 'image.create' }>): CanvasImage {
  const { projectId, payload } = command;
  requireThat(!db.prepare('SELECT 1 FROM mapping_image_ids WHERE id=?').get(payload.id), 'ID_CONFLICT', '图片身份已使用，请重新创建', 409);
  readAsset(db, projectId, payload.content.assetId);
  const project = db.prepare('SELECT revision FROM mapping_projects WHERE id=?').get(projectId) as { revision: number };
  const value: CanvasImage = { id: payload.id, kind: 'image', versionId: randomUUID(), content: payload.content,
    item: { id: randomUUID(), versionId: randomUUID(), createdOrder: project.revision + 1, pose: payload.pose } };
  db.prepare('INSERT INTO mapping_image_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_images VALUES(?,?,?)').run(value.id, projectId, JSON.stringify(value));
  retainImageVersions(db, projectId, value);
  return value;
}
function retainImageVersions(db: Database.Database, projectId: string, value: CanvasImage) {
  const insert = db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)');
  insert.run(projectId, 'image', value.id, value.versionId, JSON.stringify({ id: value.id, versionId: value.versionId, content: value.content }));
  insert.run(projectId, 'pose', value.item.id, value.item.versionId, JSON.stringify(value.item));
}

export function restoreImage(db: Database.Database, projectId: string, change: ImageChange, type: 'history.undo' | 'history.redo'): ImageChange {
  const desired = type === 'history.undo' ? change.before : change.after;
  const identity = change.after ?? change.before!;
  const before = readImages(db, projectId).find(value => value.id === identity.id) ?? null;
  const after = desired ? structuredClone(desired) : null;
  if (after) {
    if (before && change.before && change.after && change.before.versionId === change.after.versionId) {
      after.content = before.content; after.versionId = before.versionId;
    } else after.versionId = randomUUID();
    if (before && change.before && change.after && change.before.item.versionId === change.after.item.versionId) after.item = before.item;
    else after.item.versionId = randomUUID();
    db.prepare('INSERT INTO mapping_images VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(after.id, projectId, JSON.stringify(after));
    retainImageVersions(db, projectId, after);
  } else db.prepare('DELETE FROM mapping_images WHERE id=? AND project_id=?').run(identity.id, projectId);
  return { before, after };
}

export function transformImage(db: Database.Database, command: Extract<ImageCommand, { type: 'image.transform' }>): ImageChange | null {
  const before = readImages(db, command.projectId).find(value => value.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '图片不存在于当前项目', 404);
  requireThat(command.expected.image === before.versionId && command.expected.pose === before.item.versionId, 'VERSION_CONFLICT', '图片或布局已更新，请重新读取', 409);
  const pose = { ...command.payload.pose, rotation: before.item.pose.rotation };
  if (Object.keys(pose).every(key => pose[key as keyof typeof pose] === before.item.pose[key as keyof typeof pose])) return null;
  const after = structuredClone(before);
  after.item = { ...after.item, versionId: randomUUID(), pose };
  db.prepare('UPDATE mapping_images SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(after), after.id, command.projectId);
  retainImageVersions(db, command.projectId, after);
  return { before, after };
}

export function rotateImage(db: Database.Database, command: Extract<ImageCommand, { type: 'image.rotate' }>): ImageChange {
  const before = readImages(db, command.projectId).find(value => value.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '图片不存在于当前项目', 404);
  requireThat(command.expected.image === before.versionId && command.expected.pose === before.item.versionId, 'VERSION_CONFLICT', '图片或布局已更新，请重新读取', 409);
  const p = before.item.pose, after = structuredClone(before);
  const rotation = ((p.rotation + (command.payload.direction === 'right' ? 90 : 270)) % 360) as typeof p.rotation;
  after.item = { ...after.item, versionId: randomUUID(), pose: {
    x: p.x + (p.width - p.height) / 2, y: p.y + (p.height - p.width) / 2,
    width: p.height, height: p.width, rotation,
  } };
  db.prepare('UPDATE mapping_images SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(after), after.id, command.projectId);
  retainImageVersions(db, command.projectId, after);
  return { before, after };
}

export function deleteImage(db: Database.Database, command: Extract<ImageCommand, { type: 'image.delete' }>): ImageChange {
  const before = readImages(db, command.projectId).find(value => value.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '图片不存在于当前项目', 404);
  requireThat(command.expected.image === before.versionId && command.expected.pose === before.item.versionId, 'VERSION_CONFLICT', '删除依据已更新，请重新读取', 409);
  db.prepare('DELETE FROM mapping_images WHERE id=? AND project_id=?').run(before.id, command.projectId);
  return { before, after: null };
}
