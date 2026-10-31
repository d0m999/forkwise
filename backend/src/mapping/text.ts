import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { CanvasText, TextChange, TextCommand } from './text-contracts.js';
import { nextCreatedOrder } from './created-order.js';
export function initializeText(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_texts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mapping_text_ids(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id));`);
}
export function readTexts(db: Database.Database, projectId: string): CanvasText[] {
  return (
    db
      .prepare('SELECT value FROM mapping_texts WHERE project_id=? ORDER BY rowid')
      .all(projectId) as { value: string }[]
  ).map((row) => JSON.parse(row.value));
}
function persist(db: Database.Database, projectId: string, value: CanvasText) {
  db.prepare(
    'INSERT INTO mapping_texts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
  ).run(value.id, projectId, JSON.stringify(value));
  const insert = db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)');
  insert.run(
    projectId,
    'text',
    value.id,
    value.versionId,
    JSON.stringify({ id: value.id, content: value.content, versionId: value.versionId }),
  );
  insert.run(projectId, 'pose', value.item.id, value.item.versionId, JSON.stringify(value.item));
}
export function writeText(db: Database.Database, command: TextCommand): TextChange | null {
  const { projectId } = command;
  const createdOrder = () =>
    nextCreatedOrder(
      db,
      projectId,
      (
        db.prepare('SELECT revision FROM mapping_projects WHERE id=?').get(projectId) as {
          revision: number;
        }
      ).revision,
    );
  if (command.type === 'text.create') {
    const { payload } = command;
    requireThat(
      !db.prepare('SELECT 1 FROM mapping_text_ids WHERE id=?').get(payload.id),
      'ID_CONFLICT',
      '身份已使用，请重新创建',
      409,
    );
    const after: CanvasText = {
      id: payload.id,
      kind: 'text',
      versionId: randomUUID(),
      content: payload.content,
      item: {
        id: randomUUID(),
        versionId: randomUUID(),
        createdOrder: createdOrder(),
        pose: command.payload.pose,
      },
    };
    db.prepare('INSERT INTO mapping_text_ids VALUES(?,?)').run(after.id, projectId);
    persist(db, projectId, after);
    return { before: null, after };
  }
  const before = readTexts(db, projectId).find((value) => value.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '文字不存在于当前项目', 404);
  if (command.type !== 'text.move')
    requireThat(
      (command.type === 'text.edit' ? command.expected : command.expected.text) ===
        before.versionId,
      'VERSION_CONFLICT',
      '文字已更新，请重新读取',
      409,
    );
  if (command.type !== 'text.edit')
    requireThat(
      (command.type === 'text.move' ? command.expected : command.expected.pose) ===
        before.item.versionId,
      'VERSION_CONFLICT',
      '布局已更新，请重新读取',
      409,
    );
  if (command.type === 'text.layout') {
    if (
      before.item.pose.width === command.payload.width &&
      before.item.pose.height === command.payload.height
    )
      return null;
    const after = structuredClone(before);
    after.item = {
      ...after.item,
      versionId: randomUUID(),
      pose: { ...after.item.pose, width: command.payload.width, height: command.payload.height },
    };
    persist(db, projectId, after);
    return { before, after };
  }
  if (command.type === 'text.copy') {
    requireThat(
      !db.prepare('SELECT 1 FROM mapping_text_ids WHERE id=?').get(command.payload.copyId),
      'ID_CONFLICT',
      '身份已使用，请重新创建',
      409,
    );
    const after = structuredClone(before);
    after.id = command.payload.copyId;
    after.versionId = randomUUID();
    after.item = {
      id: randomUUID(),
      versionId: randomUUID(),
      createdOrder: createdOrder(),
      pose: { ...after.item.pose, x: after.item.pose.x + 24, y: after.item.pose.y + 24 },
    };
    db.prepare('INSERT INTO mapping_text_ids VALUES(?,?)').run(after.id, projectId);
    persist(db, projectId, after);
    return { before: null, after };
  }
  if (command.type === 'text.delete') {
    db.prepare('DELETE FROM mapping_texts WHERE id=? AND project_id=?').run(before.id, projectId);
    return { before, after: null };
  }
  const after = structuredClone(before);
  if (
    command.type !== 'text.move' &&
    JSON.stringify(command.payload.content) !== JSON.stringify(before.content)
  ) {
    after.content = command.payload.content;
    after.versionId = randomUUID();
  }
  const nextPose =
    command.type === 'text.move'
      ? { ...before.item.pose, x: command.payload.x, y: command.payload.y }
      : command.type === 'text.transform'
        ? command.payload.pose
        : before.item.pose;
  if (JSON.stringify(nextPose) !== JSON.stringify(before.item.pose))
    after.item = { ...after.item, versionId: randomUUID(), pose: nextPose };
  if (after.versionId === before.versionId && after.item.versionId === before.item.versionId)
    return null;
  persist(db, projectId, after);
  return { before, after };
}
export function restoreText(
  db: Database.Database,
  projectId: string,
  change: TextChange,
  type: 'history.undo' | 'history.redo',
): TextChange {
  const desired = type === 'history.undo' ? change.before : change.after;
  const identity = change.after ?? change.before!;
  const before = readTexts(db, projectId).find((value) => value.id === identity.id) ?? null;
  const after = desired ? structuredClone(desired) : null;
  if (after) {
    const contentChanged =
      !change.before || !change.after || change.before.versionId !== change.after.versionId;
    const poseChanged =
      !change.before ||
      !change.after ||
      change.before.item.versionId !== change.after.item.versionId;
    if (!contentChanged && before) {
      after.content = before.content;
      after.versionId = before.versionId;
    } else after.versionId = randomUUID();
    if (!poseChanged && before) after.item = before.item;
    else after.item.versionId = randomUUID();
    persist(db, projectId, after);
  } else
    db.prepare('DELETE FROM mapping_texts WHERE id=? AND project_id=?').run(identity.id, projectId);
  return { before, after };
}
