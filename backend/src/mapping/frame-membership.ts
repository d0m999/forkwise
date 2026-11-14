import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { canonical } from '../domain/canonical.js';
import { requireThat } from '../domain/errors.js';
import { captureSpatial, frameCandidate, type SpatialState } from './frame-spatial.js';
import type { Command } from './contracts.js';
import type { Containment, ContainmentChange } from './group-contracts.js';
import { groupItems, readContainment, readGroups, writeContainment } from './group.js';
import { readFrames } from './frame.js';
import { readAttachments } from './attachment.js';

export function readSpatialScene(db: Database.Database, projectId: string): SpatialState {
  return { frames: readFrames(db, projectId), groups: readGroups(db, projectId), containment: readContainment(db, projectId),
    cards: groupItems(db, projectId).map(v => v.value) };
}
export function validateSpatial(db: Database.Database, command: Command, expected: ReturnType<typeof captureSpatial>) {
  const scene = readSpatialScene(db, command.projectId);
  if (command.type === 'frame.create' || command.type === 'frame.resize') {
    const scope = command.type === 'frame.resize' ? { rect: command.payload.pose, frameId: command.payload.id }
      : command.payload.parentId !== undefined ? { itemIds: command.payload.itemIds } : { rect: command.payload.pose };
    requireThat(canonical(expected) === canonical(captureSpatial(scene, scope)),
      'VERSION_CONFLICT', '分区收纳候选或对象范围已更新，请重新预览', 409);
    return;
  }
  const actual = captureSpatial(scene), frameIds = new Set([...Object.keys(expected.frames), ...Object.keys(actual.frames)]);
  requireThat(canonical(expected.frames) === canonical(actual.frames) && [...frameIds].every(id =>
    (expected.containment[id] ?? null) === (actual.containment[id] ?? null)),
    'VERSION_CONFLICT', '分区候选已更新，请重新预览', 409);
  let roots: string[] = [];
  if (command.type === 'frame.move') roots = [command.payload.id];
  else if (command.type === 'canvas.move') roots = command.payload.targets.map(v => v.itemId);
  else if (command.type === 'group.move' || command.type === 'canvas.move-selection') {
    const groupIds = command.type === 'group.move' ? [command.payload.id] : command.payload.groupIds;
    roots = [...(command.type === 'canvas.move-selection' ? command.payload.directItemIds : []),
      ...(scene.groups ?? []).filter(v => groupIds.includes(v.id)).map(v => v.itemId)];
  } else if (command.type === 'pose.batch') {
    const ids = new Set(command.payload.poses.map(v => v.id)); roots = groupItems(db, command.projectId).filter(v => v.kind === 'card' && ids.has(v.value.id)).map(v => v.value.item.id);
  } else if (['pose.move', 'shape.move', 'text.move', 'text.transform', 'image.transform'].includes(command.type) && 'id' in command.payload) {
    const id = command.payload.id;
    roots = groupItems(db, command.projectId).filter(v => v.value.id === id).map(v => v.value.item.id);
  }
  requireThat(roots.every(id => (expected.containment[id] ?? null) === (actual.containment[id] ?? null)),
    'VERSION_CONFLICT', '移动对象归属已更新，请重新预览', 409);
}

export function updateFrameParents(db: Database.Database, projectId: string,
  targets: { id: string; point: { x: number; y: number } }[], scene = readSpatialScene(db, projectId)): ContainmentChange[] {
  const changes: ContainmentChange[] = [];
  const attached = new Set(readAttachments(db, projectId).map(value => value.id));
  for (const target of targets) {
    if (attached.has(target.id)) continue;
    const before = scene.containment?.find(v => v.id === target.id) ?? null;
    if (before?.parent?.kind === 'group') continue;
    const frame = frameCandidate(scene, target.point, (scene.frames ?? []).some(v => v.id === target.id) ? [target.id] : []);
    if ((before?.parent?.id ?? null) === (frame?.id ?? null)) continue;
    const after: Containment = { id: target.id, versionId: randomUUID(), parent: frame ? { kind: 'frame', id: frame.id } : null };
    writeContainment(db, projectId, after); changes.push({ before, after });
  }
  return changes;
}
