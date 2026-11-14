import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { FrameCommand } from './frame-contracts.js';
import type { Containment, ContainmentChange } from './group-contracts.js';
import { writeContainment } from './group.js';
import { readSpatialScene } from './frame-membership.js';
import { frameResizePlan } from './frame-spatial.js';
import { readAttachments } from './attachment.js';

export function resizeFrame(db: Database.Database, command: Extract<FrameCommand, { type: 'frame.resize' }>) {
  const scene = readSpatialScene(db, command.projectId), before = scene.frames!.find(v => v.id === command.payload.id);
  requireThat(before, 'NOT_FOUND', '分区不存在于当前项目', 404);
  requireThat(before.versionId === command.expected, 'VERSION_CONFLICT', '分区已更新，请重新预览', 409);
  const pose = command.payload.pose;
  if (Object.entries(pose).every(([key, value]) => before.pose[key as keyof typeof pose] === value)) return null;
  const plan = frameResizePlan(scene, before.id, pose), containmentChanges: ContainmentChange[] = [];
  const attached = new Set(readAttachments(db, command.projectId).map(value => value.id));
  for (const id of [...plan.attach, ...plan.release]) {
    if (plan.attach.includes(id) && attached.has(id)) continue;
    const previous = scene.containment!.find(v => v.id === id) ?? null;
    const parent = plan.attach.includes(id) ? { kind: 'frame' as const, id: before.id } : null;
    if ((previous?.parent?.id ?? null) === (parent?.id ?? null)) continue;
    const after: Containment = { id, versionId: randomUUID(), parent };
    writeContainment(db, command.projectId, after); containmentChanges.push({ before: previous, after });
  }
  const { kind: _kind, memberItemIds: _members, ...record } = before;
  const after = { ...record, pose, versionId: randomUUID() };
  db.prepare('UPDATE mapping_frames SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(after), after.id, command.projectId);
  db.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)').run(command.projectId, 'frame', after.id, after.versionId, JSON.stringify(after));
  return { frameChange: { before: record, after }, containmentChanges, changedIds: [after.id, ...containmentChanges.map(v => (v.after ?? v.before!).id)] };
}
