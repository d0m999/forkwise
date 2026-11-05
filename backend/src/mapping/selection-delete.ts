import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';
import type { GroupCommand, GroupChange, ContainmentChange } from './group-contracts.js';
import { readGroupRecords, readContainment, groupItems } from './group.js';
import { deleteGroupItems, releaseMembers, groupOutcome, ungroup } from './group-lifecycle.js';
import { readConnectors, prepareIncidentConnectorDeletion } from './connector.js';
import { readFrames, deleteFrame } from './frame.js';
import type { FrameChange } from './frame-contracts.js';

function exactIds(expected: Record<string, unknown>, ids: Set<string>) {
  return Object.keys(expected).length === ids.size && [...ids].every(id => Object.hasOwn(expected, id));
}

export function deleteSelection(db: Database.Database, command: Extract<GroupCommand, { type: 'canvas.delete-selection' }>) {
  const { projectId, expected, payload } = command;
  const groups = readGroupRecords(db, projectId), containment = readContainment(db, projectId), frames = readFrames(db, projectId);
  // Validate captured facts before expanding the current relationship closure.
  for (const [id, version] of Object.entries(expected.groups))
    requireThat(groups.some(group => group.id === id && group.versionId === version), 'VERSION_CONFLICT', '删除涉及的组合已更新，请重新明确操作', 409);
  for (const [id, version] of Object.entries(expected.frames ?? {}))
    requireThat(frames.some(frame => frame.id === id && frame.versionId === version), 'VERSION_CONFLICT', '删除涉及的分区已更新，请重新明确操作', 409);
  for (const [id, version] of Object.entries(expected.containment)) {
    const actual = containment.find(value => value.id === id);
    requireThat(version === null ? !actual : actual?.versionId === version, 'VERSION_CONFLICT', '删除对象归属已更新，请重新明确操作', 409);
  }
  const selectedGroups = new Set(payload.groupIds), ids = new Set(payload.directItemIds), affectedGroups = new Set([...selectedGroups, ...(payload.ungroupIds ?? [])]);
  for (const id of selectedGroups) {
    const group = groups.find(value => value.id === id);
    requireThat(group, 'VERSION_CONFLICT', '所选组合已变化，请重新明确操作', 409);
    for (const member of containment.filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId)) ids.add(member.id);
  }
  const membershipIds = new Set(ids), affectedFrames = new Set<string>();
  for (const group of groups.filter(value => {
    const members = containment.filter(member => member.parent?.kind === 'group' && member.parent.id === value.itemId);
    return members.length > 0 && members.every(member => ids.has(member.id));
  })) {
    if (containment.some(value => value.id === group.itemId)) membershipIds.add(group.itemId);
  }
  for (const id of membershipIds) {
    const parent = containment.find(value => value.id === id)?.parent;
    if (!parent) continue;
    if (parent.kind === 'frame') {
      affectedFrames.add(parent.id);
      continue;
    }
    const group = groups.find(value => value.itemId === parent.id);
    requireThat(group, 'VERSION_CONFLICT', '删除对象的父组合已变化，请重新明确操作', 409);
    affectedGroups.add(group.id);
  }
  const deletionMembershipIds = new Set(membershipIds);
  for (const id of payload.ungroupIds ?? []) {
    const group = groups.find(group => group.id === id);
    requireThat(group, 'VERSION_CONFLICT', '解组目标已变化，请重新读取', 409);
    for (const value of containment.filter(value => value.id === group.itemId || value.parent?.kind === 'group' && value.parent.id === group.itemId)) membershipIds.add(value.id);
    const parent = containment.find(value => value.id === group.itemId)?.parent;
    if (parent?.kind === 'frame') affectedFrames.add(parent.id);
  }
  for (const id of payload.frameIds ?? []) {
    requireThat(frames.some(frame => frame.id === id), 'VERSION_CONFLICT', '分区目标已变化，请重新读取', 409);
    affectedFrames.add(id);
    for (const value of containment.filter(value => value.id === id || value.parent?.kind === 'frame' && value.parent.id === id)) membershipIds.add(value.id);
  }
  const members = groupItems(db, projectId).filter(value => ids.has(value.value.item.id));
  requireThat(exactIds(expected.groups, affectedGroups) && exactIds(expected.frames ?? {}, affectedFrames) &&
    exactIds(expected.containment, membershipIds) && exactIds(expected.items, ids) &&
    members.length === ids.size && members.every(value => expected.items[value.value.item.id]?.kind === value.kind),
  'VERSION_CONFLICT', '删除目标范围或类型已变化，请重新明确操作', 409);
  const explicit = new Set(payload.connectorIds ?? []);
  const ordinaryConnectors = Object.fromEntries(Object.entries(expected.connectors).filter(([id]) => !explicit.has(id)));
  // An explicit line can also be incident to a deleted ordinary item.
  const incidentLines = readConnectors(db, projectId).filter(line => [line.start, line.end].some(end => end.kind === 'bound' && (end.targetKind ?? 'item') === 'item' && ids.has(end.itemId)));
  const incident = prepareIncidentConnectorDeletion(db, projectId, [...ids], {
    ...ordinaryConnectors, ...Object.fromEntries(incidentLines.filter(line => explicit.has(line.id)).map(line => [line.id, expected.connectors[line.id]!])),
  });
  requireThat(exactIds(expected.connectors, new Set([...incident.map(change => change.before!.id), ...explicit])), 'VERSION_CONFLICT', '删除连线范围已变化，请重新读取', 409);
  // The outer Mapping immediate transaction rolls back all primitives if a later domain conflicts.
  const content = deleteGroupItems(db, command, members, expected.items, incident);
  const groupChanges: GroupChange[] = [], containmentChanges: ContainmentChange[] = [];
  for (const group of groups.filter(value => affectedGroups.has(value.id))) {
    const memberIds = containment.filter(value => ids.has(value.id) && value.parent?.kind === 'group' && value.parent.id === group.itemId).map(value => value.id);
    if (!memberIds.length) continue;
    const released = releaseMembers(db, projectId, group.id, memberIds, {
      group: expected.groups[group.id]!, parentContainment: expected.containment[group.itemId], containment: Object.fromEntries(memberIds.map(id => [id, expected.containment[id]!])),
    }, true);
    groupChanges.push(...released.groupChanges); containmentChanges.push(...released.containmentChanges);
  }
  for (const before of containment.filter(value => deletionMembershipIds.has(value.id) && (value.parent === null || value.parent.kind === 'frame'))) {
    if (containmentChanges.some(change => change.before?.id === before.id)) continue;
    db.prepare('DELETE FROM mapping_containment WHERE project_id=? AND item_id=?').run(projectId, before.id);
    containmentChanges.push({ before, after: null });
  }
  for (const id of payload.ungroupIds ?? []) {
    const group = readGroupRecords(db, projectId).find(group => group.id === id);
    if (!group) continue;
    const current = readContainment(db, projectId);
    const released = ungroup(db, { ...command, type: 'group.ungroup', payload: { id }, expected: { group: group.versionId,
      parentContainment: current.find(value => value.id === group.itemId)?.versionId ?? null,
      containment: Object.fromEntries(current.filter(value => value.parent?.kind === 'group' && value.parent.id === group.itemId).map(value => [value.id, value.versionId])) } });
    groupChanges.push(...released.groupChanges); containmentChanges.push(...released.containmentChanges);
  }
  const frameChanges: FrameChange[] = [];
  for (const id of payload.frameIds ?? []) {
    const frame = readFrames(db, projectId).find(frame => frame.id === id)!;
    const released = deleteFrame(db, { ...command, type: 'frame.delete', payload: { id }, expected: { frame: frame.versionId,
      containment: Object.fromEntries(readContainment(db, projectId).filter(value => value.id === id || value.parent?.kind === 'frame' && value.parent.id === id).map(value => [value.id, value.versionId])) } });
    frameChanges.push(released.frameChange); containmentChanges.push(...released.containmentChanges);
  }
  const coalesce = <T extends { before: { id: string } | null; after: { id: string } | null }>(values: T[]) => {
    const result = new Map<string, T>();
    for (const value of values) { const id = (value.after ?? value.before!).id, previous = result.get(id); result.set(id, previous ? { ...value, before: previous.before } : value); }
    return [...result.values()];
  };
  const changes = { ...content, frameChanges, groupChanges: coalesce(groupChanges), containmentChanges: coalesce(containmentChanges) };
  return { ...changes, ...groupOutcome(changes) };
}
