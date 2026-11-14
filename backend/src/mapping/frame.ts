import { containsRect, frameCreationParent, frameDescendants, normalizeFrameRoots, frameDrawMembers } from './frame-spatial.js';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { CanvasFrame, FrameChange, FrameCommand, FrameRecord } from './frame-contracts.js';
import type { Containment, ContainmentChange } from './group-contracts.js';
import { groupItems, readContainment, readGroupRecords, readGroups, writeContainment } from './group.js';
import { moveCanvas } from './canvas-move.js';
import { followMemberMotions, rejectAttachedMembers } from './attachment.js';

export function initializeFrames(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_frames(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mapping_frame_ids(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id));
    INSERT OR IGNORE INTO mapping_frame_ids SELECT id,project_id FROM mapping_frames ORDER BY rowid;`);
}

export function readFrames(db: Database.Database, projectId: string): CanvasFrame[] {
  const containment = readContainment(db, projectId);
  return readFrameRecords(db, projectId).map(frame => ({
    ...frame,
    kind: 'frame',
    memberItemIds: containment.filter(value => value.parent?.kind === 'frame' && value.parent.id === frame.id).map(value => value.id),
  }));
}

export function readFrameRecords(db: Database.Database, projectId: string): FrameRecord[] {
  return (db.prepare('SELECT f.value FROM mapping_frames f JOIN mapping_frame_ids i ON i.id=f.id WHERE f.project_id=? ORDER BY i.rowid')
    .all(projectId) as { value: string }[]).map(row => JSON.parse(row.value));
}

function retainFrameVersion(db: Database.Database, projectId: string, frame: FrameRecord) {
  db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)')
    .run(projectId, 'frame', frame.id, frame.versionId, JSON.stringify(frame));
}

export function createFrame(db: Database.Database, command: Extract<FrameCommand, { type: 'frame.create' }>) {
  const { projectId, payload, expected } = command;
  requireThat(!db.prepare('SELECT 1 FROM mapping_frame_ids WHERE id=?').get(payload.id),
    'ID_CONFLICT', '分区身份已使用，请重新创建', 409);
  const items = groupItems(db, projectId), memberships = readContainment(db, projectId), groups = readGroupRecords(db, projectId);
  for (const [id, version] of Object.entries(expected.groups))
    requireThat(groups.some(group => group.id === id && group.versionId === version), 'VERSION_CONFLICT', '组合已更新，请重新读取', 409);
  for (const [id, version] of Object.entries(expected.containment))
    requireThat(version === (memberships.find(value => value.id === id)?.versionId ?? null), 'VERSION_CONFLICT', '成员归属已更新，请重新读取', 409);
  for (const [id, version] of Object.entries(expected.poses))
    requireThat(items.some(({ value }) => value.item.id === id && value.item.versionId === version), 'VERSION_CONFLICT', '对象布局已更新，请重新读取', 409);
  const frames = readFrames(db, projectId);
  const scene = { frames, groups: readGroups(db, projectId), containment: memberships, cards: items.map(v => v.value) };
  const parent = payload.parentId === undefined ? frameCreationParent(scene, payload.pose) : frames.find(v => v.id === payload.parentId) ?? null;
  requireThat(payload.parentId == null || parent, 'INVALID_FRAME_MEMBER', '父分区不存在', 400);
  const directIds = [...new Set(payload.itemIds)], ordinaryIds = new Set<string>(), selectedGroups = [];
  for (const id of directIds) {
    const group = groups.find(value => value.itemId === id);
    if (group) {
      selectedGroups.push(group);
      for (const member of memberships.filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId)) ordinaryIds.add(member.id);
    } else if (frames.some(frame => frame.id === id)) {
      requireThat(containsRect(payload.pose, frames.find(frame => frame.id === id)!.pose), 'INVALID_FRAME_MEMBER', '只能收纳完整子分区', 400);
    } else {
      requireThat(items.some(({ value }) => value.item.id === id), 'INVALID_FRAME_MEMBER', '只能收纳当前项目的普通画布项或完整组合', 400);
      ordinaryIds.add(id);
    }
  }
  requireThat(Object.keys(expected.groups).length === selectedGroups.length && selectedGroups.every(group => Object.hasOwn(expected.groups, group.id)) &&
    Object.keys(expected.containment).length === directIds.length && directIds.every(id => Object.hasOwn(expected.containment, id)) &&
    Object.keys(expected.poses).length === ordinaryIds.size && [...ordinaryIds].every(id => Object.hasOwn(expected.poses, id)),
    'EXPECTED_DOMAINS', '须校验选中组合、直接成员归属及全部普通对象布局', 400);
  requireThat(directIds.every(id => memberships.find(v => v.id === id)?.parent?.kind !== 'group'), 'INVALID_FRAME_MEMBER', '不能拆分已有组合', 400);
  requireThat(normalizeFrameRoots(scene, directIds).length === directIds.length, 'INVALID_FRAME_MEMBER', '不能同时收纳子分区及其后代', 400);
  requireThat(payload.parentId === undefined || directIds.every(id => { const current = memberships.find(value => value.id === id)?.parent; return parent ? current?.kind === 'frame' && current.id === parent.id : !current; }),
    'INVALID_FRAME_MEMBER', '分区直接成员须位于同一直接容器', 400);
  rejectAttachedMembers(db, projectId, ordinaryIds);
  const ordinary = items.filter(({ value }) => ordinaryIds.has(value.item.id));
  requireThat(ordinary.length === ordinaryIds.size && ordinary.every(({ value }) => {
    const pose = value.item.pose;
    return pose.x >= payload.pose.x && pose.y >= payload.pose.y &&
      pose.x + pose.width <= payload.pose.x + payload.pose.width &&
      pose.y + pose.height <= payload.pose.y + payload.pose.height;
  }), 'INVALID_FRAME_MEMBER', '只能收纳完整位于分区内的普通对象或组合', 400);
  if (payload.parentId === undefined) {
    const planned = frameDrawMembers(scene, payload.pose);
    requireThat(directIds.length === planned.length && planned.every(id => directIds.includes(id)),
      'EXPECTED_DOMAINS', '须提交完整分区收纳计划，请重新预览', 400);
  }
  const frame: FrameRecord = {
    id: payload.id,
    versionId: randomUUID(),
    name: `分区${readFrameRecords(db, projectId).length + 1}`,
    background: null,
    pose: payload.pose,
  };
  db.prepare('INSERT INTO mapping_frame_ids VALUES(?,?)').run(frame.id, projectId);
  db.prepare('INSERT INTO mapping_frames VALUES(?,?,?)').run(frame.id, projectId, JSON.stringify(frame));
  retainFrameVersion(db, projectId, frame);
  const containmentChanges: ContainmentChange[] = directIds.map(id => {
    const before = memberships.find(value => value.id === id) ?? null;
    const after: Containment = { id, versionId: randomUUID(), parent: { kind: 'frame', id: frame.id } };
    writeContainment(db, projectId, after);
    return { before, after };
  });
  if (parent) {
    const after: Containment = { id: frame.id, versionId: randomUUID(), parent: { kind: 'frame', id: parent.id } };
    writeContainment(db, projectId, after); containmentChanges.push({ before: null, after });
  }
  return { frame, containmentChanges, changedIds: [frame.id, ...directIds] };
}

export function moveFrame(db: Database.Database, command: Extract<FrameCommand, { type: 'frame.move' }>) {
  const { projectId, payload, expected } = command;
  const before = readFrameRecords(db, projectId).find(frame => frame.id === payload.id);
  requireThat(before, 'NOT_FOUND', '分区不存在于当前项目', 404);
  requireThat(expected.frame === before.versionId, 'VERSION_CONFLICT', '分区已更新，请重新读取', 409);
  const memberships = readContainment(db, projectId), groups = readGroupRecords(db, projectId);
  const allFrames = readFrames(db, projectId), descendants = frameDescendants({ frames: allFrames, containment: memberships, cards: [] }, [before.id]);
  const direct = memberships.filter(value => value.parent?.kind === 'frame' && descendants.has(value.parent.id));
  const relatedGroups = groups.filter(group => direct.some(value => value.id === group.itemId));
  const internal = memberships.filter(value => value.parent?.kind === 'group' && relatedGroups.some(group => group.itemId === value.parent!.id));
  for (const [id, version] of Object.entries(expected.groups))
    requireThat(groups.some(group => group.id === id && group.versionId === version), 'VERSION_CONFLICT', '组合已更新，请重新读取', 409);
  const affectedMemberships = new Set([...direct, ...internal].map(value => value.id));
  requireThat(Object.keys(expected.groups).length === relatedGroups.length && relatedGroups.every(group => Object.hasOwn(expected.groups, group.id)) &&
    Object.keys(expected.containment).length === affectedMemberships.size && [...affectedMemberships].every(id => memberships.find(v => v.id === id)?.versionId === expected.containment[id]),
    'VERSION_CONFLICT', '须校验全部后代组合及成员归属', 409);
  const ordinaryIds = new Set(internal.map(value => value.id));
  for (const value of direct) if (!relatedGroups.some(group => group.itemId === value.id) && !descendants.has(value.id)) ordinaryIds.add(value.id);
  const ordinary = groupItems(db, projectId).filter(({ value }) => ordinaryIds.has(value.item.id));
  requireThat(ordinary.length === ordinaryIds.size, 'NOT_FOUND', '分区成员不存在于当前项目', 404);
  const { dx, dy } = payload;
  const followed = followMemberMotions(db, projectId, command.commandId, ordinary, dx, dy, command.followers, command.expectedFollowers);
  const moved = moveCanvas(db, { commandId: command.commandId, projectId, type: 'canvas.move', expected: expected.poses,
    payload: { targets: ordinary.map(({ kind, value }) => ({ kind, id: value.id, itemId: value.item.id,
      x: value.item.pose.x + payload.dx, y: value.item.pose.y + payload.dy })) } });
  if (payload.dx === 0 && payload.dy === 0) return null;
  const frameChanges: FrameChange[] = allFrames.filter(v => descendants.has(v.id)).map(before => {
    const after: FrameRecord = { ...before, versionId: randomUUID(), pose: { ...before.pose, x: before.pose.x + payload.dx, y: before.pose.y + payload.dy } };
    db.prepare('UPDATE mapping_frames SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(after), after.id, projectId);
    retainFrameVersion(db, projectId, after); return { before, after };
  });
  return { frameChanges, ...moved, textChanges: [...moved.textChanges, ...followed.textChanges], shapeChanges: [...moved.shapeChanges, ...followed.shapeChanges], imageChanges: [...moved.imageChanges, ...followed.imageChanges], strokeChanges: [...moved.strokeChanges, ...followed.strokeChanges], changedIds: [...new Set([...descendants, ...moved.changedIds, ...followed.changedIds])] };
}

export function deleteFrame(db: Database.Database, command: Extract<FrameCommand, { type: 'frame.delete' }>) {
  const { projectId, payload, expected } = command;
  const before = readFrameRecords(db, projectId).find(frame => frame.id === payload.id);
  requireThat(before, 'NOT_FOUND', '分区不存在于当前项目', 404);
  requireThat(expected.frame === before.versionId, 'VERSION_CONFLICT', '分区已更新，请重新读取', 409);
  const memberships = readContainment(db, projectId);
  const own = memberships.find(v => v.id === before.id);
  const direct = memberships.filter(value => value.parent?.kind === 'frame' && value.parent.id === before.id);
  const affected = own ? [...direct, own] : direct;
  requireThat(Object.keys(expected.containment).length === affected.length && affected.every(value => expected.containment[value.id] === value.versionId),
    'VERSION_CONFLICT', '分区成员归属已更新，请重新读取', 409);
  db.prepare('DELETE FROM mapping_frames WHERE id=? AND project_id=?').run(before.id, projectId);
  const containmentChanges: ContainmentChange[] = direct.map(value => {
    const after = { ...value, parent: null, versionId: randomUUID() };
    writeContainment(db, projectId, after);
    return { before: value, after };
  });
  if (own) {
    db.prepare('DELETE FROM mapping_containment WHERE project_id=? AND item_id=?').run(projectId, own.id);
    containmentChanges.push({ before: own, after: null } as ContainmentChange);
  }
  return { frameChange: { before, after: null }, containmentChanges, changedIds: [before.id, ...direct.map(value => value.id)] };
}

export function editFrame(db: Database.Database, command: Extract<FrameCommand, { type: 'frame.edit' }>): FrameChange | null {
  const before = readFrameRecords(db, command.projectId).find(frame => frame.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '分区不存在于当前项目', 404);
  requireThat(command.expected === before.versionId, 'VERSION_CONFLICT', '分区已更新，请重新读取', 409);
  if (before.name === command.payload.name && before.background === command.payload.background) return null;
  const after: FrameRecord = { ...before, name: command.payload.name, background: command.payload.background, versionId: randomUUID() };
  db.prepare('UPDATE mapping_frames SET value=? WHERE id=? AND project_id=?')
    .run(JSON.stringify(after), after.id, command.projectId);
  retainFrameVersion(db, command.projectId, after);
  return { before, after };
}

export function restoreFrame(db: Database.Database, projectId: string, change: FrameChange, type: 'history.undo' | 'history.redo'): FrameChange {
  const desired = type === 'history.undo' ? change.before : change.after;
  const identity = change.after ?? change.before!;
  const before = readFrameRecords(db, projectId).find(frame => frame.id === identity.id) ?? null;
  const after = desired ? { ...desired, versionId: randomUUID() } : null;
  if (after) {
    db.prepare('INSERT OR IGNORE INTO mapping_frame_ids VALUES(?,?)').run(after.id, projectId);
    db.prepare('INSERT INTO mapping_frames VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(after.id, projectId, JSON.stringify(after));
    retainFrameVersion(db, projectId, after);
  } else db.prepare('DELETE FROM mapping_frames WHERE id=? AND project_id=?').run(identity.id, projectId);
  return { before, after };
}
