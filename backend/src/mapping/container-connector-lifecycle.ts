import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { Command } from './contracts.js';
import type { ConnectorChange } from './connector-contracts.js';
import { endpointKey } from './connector-contracts.js';
import { readConnectors, saveConnector } from './connector.js';
import { groupItems, readContainment, readGroups } from './group.js';
import { readFrames } from './frame.js';
import { captureContainerEndpoints, endpointBounds, sidePoint, type ContainerEndpointDependencies } from './container-endpoints.js';

// Plan from the transaction's before snapshot, including containers emptied indirectly.
export function planContainerConnectorRemoval(db: Database.Database, command: Command): ConnectorChange[] {
  if (!['group.ungroup', 'group.remove-member', 'group.create', 'group.delete', 'frame.delete', 'canvas.delete-selection', 'canvas.cut',
    'thought.delete', 'text.delete', 'shape.delete', 'image.delete', 'stroke.delete'].includes(command.type)) return [];
  const groups = readGroups(db, command.projectId), frames = readFrames(db, command.projectId), items = groupItems(db, command.projectId);
  const state = { groups, frames, cards: items.map(value => value.value), containment: readContainment(db, command.projectId), connectors: readConnectors(db, command.projectId) };
  const removed = new Map<string, 'freeze' | 'delete'>(), deletedItems = new Set<string>(), explicitLines = new Set<string>();
  if (command.type === 'group.ungroup' || command.type === 'group.delete' || command.type === 'group.remove-member') {
    const group = groups.find(group => group.id === command.payload.id);
    if (group && (command.type !== 'group.remove-member' || group.memberItemIds.length === 1 && group.memberItemIds[0] === command.payload.itemId))
      removed.set(`group:${group.itemId}`, command.type === 'group.delete' ? 'delete' : 'freeze');
    if (group && command.type === 'group.delete') for (const id of group.memberItemIds) deletedItems.add(id);
  } else if (command.type === 'group.create') {
    const selected = new Set(command.payload.itemIds.flatMap(id => groups.find(group => group.itemId === id)?.memberItemIds ?? [id]));
    for (const group of groups) if (group.memberItemIds.every(id => selected.has(id))) removed.set(`group:${group.itemId}`, 'freeze');
  } else if (command.type === 'frame.delete') removed.set(`frame:${command.payload.id}`, 'freeze');
  else if (command.type === 'canvas.delete-selection') {
    for (const id of command.payload.directItemIds) deletedItems.add(id);
    for (const id of command.payload.groupIds) {
      const group = groups.find(group => group.id === id);
      if (group) { removed.set(`group:${group.itemId}`, 'delete'); for (const member of group.memberItemIds) deletedItems.add(member); }
    }
    for (const id of command.payload.ungroupIds ?? []) {
      const group = groups.find(group => group.id === id);
      if (group) removed.set(`group:${group.itemId}`, 'freeze');
    }
    for (const id of command.payload.frameIds ?? []) removed.set(`frame:${id}`, 'freeze');
    for (const id of command.payload.connectorIds ?? []) explicitLines.add(id);
  } else if (command.type === 'canvas.cut') {
    // 剪切整段子树：显式容器与其连线一起消失，随剪切一起恢复。
    for (const id of command.payload.itemIds) deletedItems.add(id);
    for (const id of command.payload.groupIds) {
      const group = groups.find(group => group.id === id);
      if (group) { removed.set(`group:${group.itemId}`, 'delete'); for (const member of group.memberItemIds) deletedItems.add(member); }
    }
    for (const id of command.payload.frameIds ?? []) removed.set(`frame:${id}`, 'delete');
  } else if ('id' in command.payload) {
    const kind = command.type.split('.')[0], id = command.payload.id;
    const item = items.find(value => value.value.id === id && (kind === 'thought' ? value.kind === 'card' : value.kind === kind));
    if (item) deletedItems.add(item.value.item.id);
  }
  for (const group of groups) if (group.memberItemIds.every(id => deletedItems.has(id)) && !removed.has(`group:${group.itemId}`))
    removed.set(`group:${group.itemId}`, 'freeze');
  const expected = command.expected as { endpoints?: ContainerEndpointDependencies; membership?: { endpoints?: ContainerEndpointDependencies }; connectors?: Record<string, string> };
  const actual = captureContainerEndpoints(state, [...removed.keys()]), captured = expected.endpoints ?? expected.membership?.endpoints;
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, value]) => b[id] === value);
  requireThat(!Object.keys(actual.connectors).length && !captured || captured &&
    (['connectors', 'groups', 'frames', 'containment', 'poses'] as const).every(domain => same(actual[domain], captured[domain])),
  'VERSION_CONFLICT', '容器端点、边界或关联连线已更新，请重新明确操作', 409);
  for (const id of explicitLines) requireThat(state.connectors.some(line => line.id === id && line.versionId === expected.connectors?.[id]),
    'VERSION_CONFLICT', '显式删除连线已更新，请重新读取', 409);
  return state.connectors.flatMap<ConnectorChange>(before => {
    const ends = [before.start, before.end];
    const affected = ends.some(end => end.kind === 'bound' && removed.has(endpointKey(end)));
    if (!affected && !explicitLines.has(before.id)) return [];
    if (explicitLines.has(before.id) || ends.some(end => end.kind === 'bound' &&
      (removed.get(endpointKey(end)) === 'delete' || (end.targetKind ?? 'item') === 'item' && deletedItems.has(end.itemId))))
      return [{ before, after: null }];
    const freeze = (end: typeof before.start): typeof before.start => {
      if (end.kind !== 'bound' || !removed.has(endpointKey(end))) return end;
      const bounds = endpointBounds(state, end);
      requireThat(bounds, 'VERSION_CONFLICT', '容器端点不存在，请重新读取', 409);
      return { kind: 'free', point: sidePoint(bounds, end.side) };
    };
    return [{ before, after: { ...before, versionId: randomUUID(), start: freeze(before.start), end: freeze(before.end) } }];
  });
}

export function applyContainerConnectorRemoval(db: Database.Database, projectId: string, planned: ConnectorChange[], existing: ConnectorChange[] = []) {
  const changes = new Map(existing.map(change => [(change.after ?? change.before!).id, change]));
  for (const change of planned) {
    const id = change.before!.id;
    const final = changes.get(id)?.after === null ? changes.get(id)! : change;
    if (final.after) saveConnector(db, projectId, final.after);
    else db.prepare('DELETE FROM mapping_connectors WHERE project_id=? AND id=?').run(projectId, id);
    changes.set(id, final);
  }
  return [...changes.values()];
}
