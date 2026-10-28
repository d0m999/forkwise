import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';
import type { GroupCommand, GroupChange, ContainmentChange } from './group-contracts.js';
import { readGroupRecords, readContainment, groupItems } from './group.js';
import { deleteGroupItems, releaseMembers, groupOutcome } from './group-lifecycle.js';
import { prepareIncidentConnectorDeletion } from './connector.js';

function exactIds(expected: Record<string, unknown>, ids: Set<string>) {
  return Object.keys(expected).length === ids.size && [...ids].every(id => Object.hasOwn(expected, id));
}

export function deleteSelection(db: Database.Database, command: Extract<GroupCommand, { type: 'canvas.delete-selection' }>) {
  const { projectId, expected, payload } = command;
  const groups = readGroupRecords(db, projectId), containment = readContainment(db, projectId);
  // Validate captured facts before expanding the current relationship closure.
  for (const [id, version] of Object.entries(expected.groups))
    requireThat(groups.some(group => group.id === id && group.versionId === version), 'VERSION_CONFLICT', '删除涉及的组合已更新，请重新明确操作', 409);
  for (const [id, version] of Object.entries(expected.containment)) {
    const actual = containment.find(value => value.id === id);
    requireThat(version === null ? !actual : actual?.versionId === version, 'VERSION_CONFLICT', '删除对象归属已更新，请重新明确操作', 409);
  }
  const selectedGroups = new Set(payload.groupIds), ids = new Set(payload.directItemIds), affectedGroups = new Set(selectedGroups);
  for (const id of selectedGroups) {
    const group = groups.find(value => value.id === id);
    requireThat(group, 'VERSION_CONFLICT', '所选组合已变化，请重新明确操作', 409);
    for (const member of containment.filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId)) ids.add(member.id);
  }
  for (const id of ids) {
    const parent = containment.find(value => value.id === id)?.parent;
    if (!parent) continue;
    const group = groups.find(value => parent.kind === 'group' && value.itemId === parent.id);
    requireThat(group, 'VERSION_CONFLICT', '删除对象的父组合已变化，请重新明确操作', 409);
    affectedGroups.add(group.id);
  }
  const members = groupItems(db, projectId).filter(value => ids.has(value.value.item.id));
  requireThat(exactIds(expected.groups, affectedGroups) && exactIds(expected.containment, ids) && exactIds(expected.items, ids) &&
    members.length === ids.size && members.every(value => expected.items[value.value.item.id]?.kind === value.kind),
  'VERSION_CONFLICT', '删除目标范围或类型已变化，请重新明确操作', 409);
  const incident = prepareIncidentConnectorDeletion(db, projectId, [...ids], expected.connectors);
  // The outer Mapping immediate transaction rolls back all primitives if a later domain conflicts.
  const content = deleteGroupItems(db, command, members, expected.items, incident);
  const groupChanges: GroupChange[] = [], containmentChanges: ContainmentChange[] = [];
  for (const group of groups.filter(value => affectedGroups.has(value.id))) {
    const memberIds = containment.filter(value => ids.has(value.id) && value.parent?.kind === 'group' && value.parent.id === group.itemId).map(value => value.id);
    const released = releaseMembers(db, projectId, group.id, memberIds, {
      group: expected.groups[group.id]!, containment: Object.fromEntries(memberIds.map(id => [id, expected.containment[id]!])),
    }, true);
    groupChanges.push(...released.groupChanges); containmentChanges.push(...released.containmentChanges);
  }
  for (const before of containment.filter(value => ids.has(value.id) && value.parent === null)) {
    db.prepare('DELETE FROM mapping_containment WHERE project_id=? AND item_id=?').run(projectId, before.id);
    containmentChanges.push({ before, after: null });
  }
  const changes = { ...content, groupChanges, containmentChanges };
  return { ...changes, ...groupOutcome(changes) };
}
