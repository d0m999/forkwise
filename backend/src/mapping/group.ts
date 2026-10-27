import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { Card } from './contracts.js';
import type { CanvasGroup, Containment, ContainmentChange, GroupChange, GroupCommand, GroupRecord } from './group-contracts.js';
import { readTexts } from './text.js';
import { readShapes } from './shape.js';
import { readImages } from './image.js';
import { readStrokes } from './stroke.js';
import { moveCanvas } from './canvas-move.js';

export function initializeGroups(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_groups(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mapping_group_ids(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id));
    CREATE TABLE IF NOT EXISTS mapping_containment(project_id TEXT NOT NULL REFERENCES mapping_projects(id), item_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project_id,item_id));`);
}

export function readContainment(db: Database.Database, projectId: string): Containment[] {
  return (db.prepare('SELECT value FROM mapping_containment WHERE project_id=? ORDER BY rowid').all(projectId) as { value: string }[]).map(row => JSON.parse(row.value));
}

export function readGroupRecords(db: Database.Database, projectId: string): GroupRecord[] {
  return (db.prepare('SELECT g.value FROM mapping_groups g JOIN mapping_group_ids i ON i.id=g.id WHERE g.project_id=? ORDER BY i.rowid').all(projectId) as { value: string }[]).map(row => JSON.parse(row.value));
}

// Members keep their world-coordinate Pose. There is no second writable group transform.
export function groupItems(db: Database.Database, projectId: string) {
  const cards = (db.prepare('SELECT value FROM mapping_cards WHERE project_id=? ORDER BY rowid').all(projectId) as { value: string }[]).map(row => JSON.parse(row.value) as Card);
  return [
    ...cards.map(value => ({ kind: 'card' as const, value })),
    ...readTexts(db, projectId).map(value => ({ kind: 'text' as const, value })),
    ...readShapes(db, projectId).map(value => ({ kind: 'shape' as const, value })),
    ...readImages(db, projectId).map(value => ({ kind: 'image' as const, value })),
    ...readStrokes(db, projectId).map(value => ({ kind: 'stroke' as const, value })),
  ].sort((a, b) => (a.value.item.createdOrder ?? 0) - (b.value.item.createdOrder ?? 0));
}

export function readGroups(db: Database.Database, projectId: string): CanvasGroup[] {
  const containment = readContainment(db, projectId), items = groupItems(db, projectId);
  return readGroupRecords(db, projectId).map(group => {
    const ids = new Set(containment.filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId).map(value => value.id));
    const members = items.filter(value => ids.has(value.value.item.id));
    const x = Math.min(...members.map(value => value.value.item.pose.x));
    const y = Math.min(...members.map(value => value.value.item.pose.y));
    const right = Math.max(...members.map(value => value.value.item.pose.x + value.value.item.pose.width));
    const bottom = Math.max(...members.map(value => value.value.item.pose.y + value.value.item.pose.height));
    return { ...group, kind: 'group', memberItemIds: members.map(value => value.value.item.id), bounds: { x, y, width: right - x, height: bottom - y } };
  });
}

export function writeGroup(db: Database.Database, projectId: string, value: GroupRecord) {
  db.prepare('INSERT OR IGNORE INTO mapping_group_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_groups VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, projectId, JSON.stringify(value));
  db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)').run(projectId, 'group', value.id, value.versionId, JSON.stringify(value));
}

export function writeContainment(db: Database.Database, projectId: string, value: Containment) {
  db.prepare('INSERT INTO mapping_containment VALUES(?,?,?) ON CONFLICT(project_id,item_id) DO UPDATE SET value=excluded.value').run(projectId, value.id, JSON.stringify(value));
  db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)').run(projectId, 'containment', value.id, value.versionId, JSON.stringify(value));
}

export function createGroup(db: Database.Database, command: Extract<GroupCommand, { type: 'group.create' }>) {
  const { projectId, payload, expected } = command;
  requireThat(!db.prepare('SELECT 1 FROM mapping_group_ids WHERE id=?').get(payload.id), 'ID_CONFLICT', '组合身份已使用，请重新创建', 409);
  const items = groupItems(db, projectId), memberships = readContainment(db, projectId), groups = readGroupRecords(db, projectId);
  // Check the caller's captured facts before deriving today's affected closure.
  // A changed parent is a version conflict, not a malformed old request.
  for (const [id, version] of Object.entries(expected.groups))
    if (id !== payload.id) requireThat(groups.some(group => group.id === id && group.versionId === version), 'VERSION_CONFLICT', '原组合已更新，请重新读取', 409);
  for (const [id, version] of Object.entries(expected.containment))
    requireThat(version === (memberships.find(value => value.id === id)?.versionId ?? null), 'VERSION_CONFLICT', '成员归属已更新，请重新读取', 409);
  const selected = new Set<string>();
  for (const id of payload.itemIds) {
    const group = groups.find(value => value.itemId === id);
    if (group) for (const member of memberships.filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId)) selected.add(member.id);
    else {
      requireThat(items.some(value => value.value.item.id === id), 'INVALID_GROUP_MEMBER', '只能组合当前项目的普通画布项', 400);
      selected.add(id);
    }
  }
  requireThat(selected.size >= 2, 'INVALID_GROUP_MEMBER', '新组合至少需要两个普通画布项', 400);
  const affected = groups.filter(group => memberships.some(value => selected.has(value.id) && value.parent?.kind === 'group' && value.parent.id === group.itemId));
  requireThat(Object.keys(expected.groups).length === affected.length + 1 && expected.groups[payload.id] === null && affected.every(group => Object.hasOwn(expected.groups, group.id)) &&
    Object.keys(expected.containment).length === selected.size && [...selected].every(id => Object.hasOwn(expected.containment, id)),
    'EXPECTED_DOMAINS', '须校验新组合、原组合及全部成员归属', 400);
  const containmentChanges: ContainmentChange[] = [...selected].map(id => {
    const before = memberships.find(value => value.id === id) ?? null;
    requireThat(!before?.parent || before.parent.kind === 'group', 'INVALID_GROUP_MEMBER', '当前操作不改变其他容器的归属', 409);
    return { before, after: null };
  });
  const project = db.prepare('SELECT revision FROM mapping_projects WHERE id=?').get(projectId) as { revision: number };
  const group: GroupRecord = { id: payload.id, itemId: randomUUID(), versionId: randomUUID(), createdOrder: project.revision + 1 };
  const groupChanges: GroupChange[] = [{ before: null, after: group }];
  for (const before of affected) {
    const remains = memberships.some(value => !selected.has(value.id) && value.parent?.kind === 'group' && value.parent.id === before.itemId);
    const after = remains ? { ...before, versionId: randomUUID() } : null;
    if (after) writeGroup(db, projectId, after);
    else db.prepare('DELETE FROM mapping_groups WHERE id=? AND project_id=?').run(before.id, projectId);
    groupChanges.push({ before, after });
  }
  writeGroup(db, projectId, group);
  const ids = [...selected];
  for (let index = 0; index < containmentChanges.length; index++) {
    const after: Containment = { id: ids[index]!, versionId: randomUUID(), parent: { kind: 'group', id: group.itemId } };
    containmentChanges[index]!.after = after;
    writeContainment(db, projectId, after);
  }
  return { groupChanges, containmentChanges, changedIds: [...new Set([...groupChanges.flatMap(value => [(value.after ?? value.before!).id, (value.after ?? value.before!).itemId]), ...ids])],
    deletedIds: groupChanges.filter(value => !value.after).flatMap(value => [value.before!.id, value.before!.itemId]) };
}

export function restoreGroups(db: Database.Database, projectId: string, groups: GroupChange[], memberships: ContainmentChange[], type: 'history.undo' | 'history.redo') {
  const currentGroups = readGroupRecords(db, projectId), currentMemberships = readContainment(db, projectId);
  const groupChanges = groups.map(change => {
    const identity = change.after ?? change.before!, desired = type === 'history.undo' ? change.before : change.after;
    const before = currentGroups.find(value => value.id === identity.id) ?? null;
    const after = desired ? { ...desired, versionId: randomUUID() } : null;
    if (after) writeGroup(db, projectId, after);
    else db.prepare('DELETE FROM mapping_groups WHERE id=? AND project_id=?').run(identity.id, projectId);
    return { before, after };
  });
  const containmentChanges = memberships.map(change => {
    const identity = change.after ?? change.before!, desired = type === 'history.undo' ? change.before : change.after;
    const before = currentMemberships.find(value => value.id === identity.id) ?? null;
    const after = desired ? { ...desired, versionId: randomUUID() } : null;
    if (after) writeContainment(db, projectId, after);
    else db.prepare('DELETE FROM mapping_containment WHERE project_id=? AND item_id=?').run(projectId, identity.id);
    return { before, after };
  });
  return { groupChanges, containmentChanges };
}

export function moveGroup(db: Database.Database, command: Extract<GroupCommand, { type: 'group.move' }>) {
  const { projectId, expected, payload } = command;
  const group = readGroupRecords(db, projectId).find(value => value.id === payload.id);
  requireThat(group, 'NOT_FOUND', '组合不存在于当前项目', 404);
  requireThat(group.versionId === expected.group, 'VERSION_CONFLICT', '组合已更新，请重新读取', 409);
  const memberships = readContainment(db, projectId).filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId);
  requireThat(Object.keys(expected.containment).length === memberships.length && memberships.every(value => expected.containment[value.id] === value.versionId),
    'VERSION_CONFLICT', '组合成员已更新，请重新读取', 409);
  const ids = new Set(memberships.map(value => value.id));
  const members = groupItems(db, projectId).filter(value => ids.has(value.value.item.id));
  return moveCanvas(db, { commandId: command.commandId, projectId, type: 'canvas.move', expected: expected.poses,
    payload: { targets: members.map(({ kind, value }) => ({ kind, id: value.id, itemId: value.item.id, x: value.item.pose.x + payload.dx, y: value.item.pose.y + payload.dy })) } });
}
