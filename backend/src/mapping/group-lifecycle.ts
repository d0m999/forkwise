import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { GroupCommand, GroupChange, ContainmentChange } from './group-contracts.js';
import { readGroupRecords, readContainment, writeGroup, writeContainment, groupItems } from './group.js';
import type { MembershipDependency } from './containment-contracts.js';
import type { Card, Change } from './contracts.js';
import { deleteCard } from './lifecycle.js';
import { writeText } from './text.js';
import { deleteShape } from './shape.js';
import { deleteImage } from './image.js';
import { deleteStroke } from './stroke.js';
import { prepareIncidentConnectorDeletion, applyIncidentConnectorDeletion } from './connector.js';

export function releaseMembers(db: Database.Database, projectId: string, id: string, itemIds: string[], expected: { group: string; containment: Record<string, string> }, deleted = false) {
  const group = readGroupRecords(db, projectId).find(value => value.id === id);
  requireThat(group, 'NOT_FOUND', '组合不存在于当前项目', 404);
  requireThat(group.versionId === expected.group, 'VERSION_CONFLICT', '组合已更新，请重新读取', 409);
  const members = readContainment(db, projectId).filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId);
  requireThat(Object.keys(expected.containment).length === itemIds.length && itemIds.every(item => members.some(value => value.id === item && value.versionId === expected.containment[item])),
    'VERSION_CONFLICT', '成员归属已更新，请重新读取', 409);
  const selected = new Set(itemIds), remains = members.some(value => !selected.has(value.id));
  const after = remains ? { ...group, versionId: randomUUID() } : null;
  if (after) writeGroup(db, projectId, after);
  else db.prepare('DELETE FROM mapping_groups WHERE id=? AND project_id=?').run(id, projectId);
  const containmentChanges: ContainmentChange[] = members.filter(value => selected.has(value.id)).map(before => {
    const after = deleted ? null : { ...before, parent: null, versionId: randomUUID() };
    if (after) writeContainment(db, projectId, after);
    else db.prepare('DELETE FROM mapping_containment WHERE project_id=? AND item_id=?').run(projectId, before.id);
    return { before, after };
  });
  return { groupChanges: [{ before: group, after }] as GroupChange[], containmentChanges, changedIds: [group.id, group.itemId, ...itemIds] };
}

export function removeMember(db: Database.Database, command: Extract<GroupCommand, { type: 'group.remove-member' }>) {
  return releaseMembers(db, command.projectId, command.payload.id, [command.payload.itemId], {
    group: command.expected.group, containment: { [command.payload.itemId]: command.expected.containment },
  });
}

export function ungroup(db: Database.Database, command: Extract<GroupCommand, { type: 'group.ungroup' }>) {
  const group = readGroupRecords(db, command.projectId).find(value => value.id === command.payload.id);
  requireThat(group, 'NOT_FOUND', '组合不存在于当前项目', 404);
  const ids = readContainment(db, command.projectId).filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId).map(value => value.id);
  return releaseMembers(db, command.projectId, group.id, ids, command.expected);
}

export function removeDeletedMember(db: Database.Database, projectId: string, itemId: string, expected?: MembershipDependency): {
  groupChanges?: GroupChange[]; containmentChanges?: ContainmentChange[]; changedIds?: string[];
} {
  const before = readContainment(db, projectId).find(value => value.id === itemId);
  if (!before?.parent) {
    requireThat(!expected, 'VERSION_CONFLICT', '成员归属已更新，请重新读取', 409);
    if (!before) return {};
    db.prepare('DELETE FROM mapping_containment WHERE project_id=? AND item_id=?').run(projectId, itemId);
    return { groupChanges: [] as GroupChange[], containmentChanges: [{ before, after: null }] as ContainmentChange[], changedIds: [itemId] };
  }
  requireThat(expected && before.parent.kind === 'group' && readGroupRecords(db, projectId).some(value => value.id === expected.group.id && value.itemId === before.parent!.id),
    'VERSION_CONFLICT', '删除前须确认当前组合及成员归属', 409);
  return releaseMembers(db, projectId, expected.group.id, [itemId], { group: expected.group.versionId, containment: { [itemId]: expected.containment } }, true);
}

// Derive the one receipt's identity closure from every actual structural/content change.
export function groupOutcome(change: Partial<Change>) {
  const changed = new Set(change.changedIds ?? []), deleted = new Set<string>();
  for (const c of change.groupChanges ?? []) {
    const value = c.after ?? c.before!; changed.add(value.id); changed.add(value.itemId);
    if (!c.after) { deleted.add(value.id); deleted.add(value.itemId); }
  }
  for (const c of change.containmentChanges ?? []) changed.add((c.after ?? c.before!).id);
  const cards = [...(change.cardLifecycleChanges ?? [])];
  if (change.before && 'body' in change.before || change.after && 'body' in change.after)
    cards.push({ before: change.before && 'body' in change.before ? change.before : null, after: change.after && 'body' in change.after ? change.after : null });
  for (const c of cards) {
    const value = c.after ?? c.before!;
    const ids = [value.id, value.body.id, value.item.id, value.appearance?.id, value.cardTags?.id].filter((id): id is string => !!id);
    for (const id of ids) changed.add(id);
    if (!c.after) for (const id of ids) deleted.add(id);
  }
  const items = [...(change.textChanges ?? []), ...(change.textChange ? [change.textChange] : []),
    ...(change.shapeChanges ?? []), ...(change.shapeChange ? [change.shapeChange] : []),
    ...(change.imageChanges ?? []), ...(change.imageChange ? [change.imageChange] : []),
    ...(change.strokeChanges ?? []), ...(change.strokeChange ? [change.strokeChange] : [])];
  for (const c of items) {
    const value = c.after ?? c.before!;
    if (c.before?.versionId !== c.after?.versionId) changed.add(value.id);
    if (c.before?.item.versionId !== c.after?.item.versionId) changed.add(value.item.id);
    if (!c.after) { deleted.add(value.id); deleted.add(value.item.id); }
  }
  for (const c of change.connectorChanges ?? []) { const id = (c.after ?? c.before!).id; changed.add(id); if (!c.after) deleted.add(id); }
  return { changedIds: [...changed], deletedIds: [...deleted] };
}

export function deleteGroup(db: Database.Database, command: Extract<GroupCommand, { type: 'group.delete' }>) {
  const { projectId, expected } = command, group = readGroupRecords(db, projectId).find(value => value.id === command.payload.id);
  requireThat(group, 'NOT_FOUND', '组合不存在于当前项目', 404);
  requireThat(group.versionId === expected.group, 'VERSION_CONFLICT', '组合已更新，请重新读取', 409);
  const membership = readContainment(db, projectId).filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId);
  requireThat(Object.keys(expected.containment).length === membership.length && membership.every(value => expected.containment[value.id] === value.versionId), 'VERSION_CONFLICT', '组合成员已更新，请重新读取', 409);
  const ids = new Set(membership.map(value => value.id)), members = groupItems(db, projectId).filter(value => ids.has(value.value.item.id));
  requireThat(Object.keys(expected.items).length === members.length && members.every(value => expected.items[value.value.item.id]?.kind === value.kind), 'VERSION_CONFLICT', '删除成员范围已更新，请重新读取', 409);
  const connectorChanges = prepareIncidentConnectorDeletion(db, projectId, [...ids], expected.connectors);
  const changes = {
    cardLifecycleChanges: [] as NonNullable<Change['cardLifecycleChanges']>,
    textChanges: [] as NonNullable<Change['textChanges']>, shapeChanges: [] as NonNullable<Change['shapeChanges']>,
    imageChanges: [] as NonNullable<Change['imageChanges']>, strokeChanges: [] as NonNullable<Change['strokeChanges']>, connectorChanges,
  };
  for (const { value } of members) {
    const expected = command.expected.items[value.item.id]!, envelope = { commandId: command.commandId, projectId, payload: { id: value.id } };
    if (expected.kind === 'card') changes.cardLifecycleChanges.push(deleteCard(db, { ...envelope, type: 'thought.delete', expected }));
    else if (expected.kind === 'text') changes.textChanges.push(writeText(db, { ...envelope, type: 'text.delete', expected })!);
    else if (expected.kind === 'shape') changes.shapeChanges.push(deleteShape(db, { ...envelope, type: 'shape.delete', expected }));
    else if (expected.kind === 'image') changes.imageChanges.push(deleteImage(db, { ...envelope, type: 'image.delete', expected }));
    else changes.strokeChanges.push(deleteStroke(db, { ...envelope, type: 'stroke.delete', expected }));
  }
  applyIncidentConnectorDeletion(db, projectId, connectorChanges);
  const structural = releaseMembers(db, projectId, group.id, [...ids], expected, true);
  const result = { ...changes, ...structural };
  return { ...result, ...groupOutcome(result) };
}
