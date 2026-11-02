import { captureOptionalContainerEndpoints } from '../../backend/src/mapping/container-endpoints';
import type { Command, ProjectState } from './api';
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';
import type { MembershipDependency } from '../../backend/src/mapping/containment-contracts';

export function membershipExpected(state: ProjectState, itemId: string): MembershipDependency | undefined {
  const membership = state.containment?.find(value => value.id === itemId);
  if (membership?.parent?.kind === 'frame') {
    const frame = state.frames?.find(value => value.id === membership.parent!.id);
    return frame ? { frame: { id: frame.id, versionId: frame.versionId }, containment: membership.versionId } : undefined;
  }
  const group = membership?.parent && state.groups?.find(value => value.itemId === membership.parent!.id);
  const parent = group && state.containment?.find(value => value.id === group.itemId);
  return group ? { ...(group.memberItemIds.length === 1 ? { endpoints: captureOptionalContainerEndpoints(state, [`group:${group.itemId}`]) } : {}), group: { id: group.id, versionId: group.versionId }, containment: membership!.versionId, ...(parent ? { parentContainment: parent.versionId } : {}) } : undefined;
}

export function captureMemberDeletion(state: ProjectState, value: ReturnType<typeof canvasItems>[number], projectId = state.project.id) {
  if (!state.groups || !state.containment || !state.connectors || state.project.id !== projectId) return null;
  const visible = canvasItems(state).find(item => item.id === value.id && item.item.id === value.item.id);
  if (!visible || visible.versionId !== value.versionId || visible.item.versionId !== value.item.versionId) return null;
  const membership = membershipExpected(state, value.item.id);
  if (state.containment.some(item => item.id === value.item.id && item.parent) && !membership) return null;
  return { membership, connectors: Object.fromEntries(state.connectors.filter(line =>
    line.start.kind === 'bound' && (line.start.targetKind ?? 'item') === 'item' && line.start.itemId === value.item.id || line.end.kind === 'bound' && (line.end.targetKind ?? 'item') === 'item' && line.end.itemId === value.item.id,
  ).map(line => [line.id, line.versionId])) };
}

export function removeMemberCommand(state: ProjectState, itemId: string): Extract<Command, { type: 'group.remove-member' }> | null {
  const membership = membershipExpected(state, itemId);
  return membership && 'group' in membership ? { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'group.remove-member',
    expected: { ...(membership.endpoints ? { endpoints: membership.endpoints } : {}), group: membership.group.versionId, containment: membership.containment, ...(membership.parentContainment ? { parentContainment: membership.parentContainment } : {}) }, payload: { id: membership.group.id, itemId } } : null;
}

export function ungroupCommand(state: ProjectState, id: string): Extract<Command, { type: 'group.ungroup' }> | null {
  const group = state.groups?.find(value => value.id === id);
  return group ? { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'group.ungroup',
    expected: { endpoints: captureOptionalContainerEndpoints(state, [`group:${group.itemId}`]), group: group.versionId, ...(state.containment?.find(value => value.id === group.itemId) ? { parentContainment: state.containment.find(value => value.id === group.itemId)!.versionId } : {}), containment: Object.fromEntries(state.containment!.filter(value => value.parent?.id === group.itemId).map(value => [value.id, value.versionId])) },
    payload: { id } } : null;
}

export function createGroupCommand(state: ProjectState, selection: CanvasSelection): Extract<Command, { type: 'group.create' }> {
  const id = crypto.randomUUID(), members = selectedItemIds(state, selection);
  const affected = state.groups?.filter(g => g.memberItemIds.some(itemId => members.includes(itemId))) ?? [];
  return { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'group.create',
    expected: { endpoints: captureOptionalContainerEndpoints(state, affected.filter(group => group.memberItemIds.every(id => members.includes(id))).map(group => `group:${group.itemId}`)), groups: { [id]: null, ...Object.fromEntries(affected.map(g => [g.id, g.versionId])) },
      containment: Object.fromEntries([...members, ...affected.filter(group => group.memberItemIds.every(id => members.includes(id)) && state.containment?.some(c => c.id === group.itemId)).map(group => group.itemId)].map(itemId => [itemId, state.containment?.find(c => c.id === itemId)?.versionId ?? null])) },
    payload: { id, itemIds: selection.targets.map(t => t.kind === 'item' ? t.itemId : state.groups!.find(g => g.id === t.id)!.itemId) } };
}

export function ungroupSelectionCommand(state: ProjectState, selection: CanvasSelection): Extract<Command, { type: 'canvas.delete-selection' }> | null {
  if (!selection.targets.length || selection.targets.some(target => target.kind !== 'group')) return null;
  const groups = state.groups?.filter(group => selection.targets.some(target => target.kind === 'group' && target.id === group.id)) ?? [];
  if (groups.length !== selection.targets.length) return null;
  const ids = new Set(groups.flatMap(group => [...group.memberItemIds, ...(state.containment?.some(value => value.id === group.itemId) ? [group.itemId] : [])]));
  const frames = new Set(state.containment?.flatMap(value => ids.has(value.id) && value.parent?.kind === 'frame' ? [value.parent.id] : []));
  return { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'canvas.delete-selection',
    payload: { groupIds: [], directItemIds: [], ungroupIds: groups.map(group => group.id) }, expected: {
      groups: Object.fromEntries(groups.map(group => [group.id, group.versionId])),
      ...(frames.size ? { frames: Object.fromEntries(state.frames!.filter(frame => frames.has(frame.id)).map(frame => [frame.id, frame.versionId])) } : {}),
      containment: Object.fromEntries([...ids].map(id => [id, state.containment!.find(value => value.id === id)!.versionId])),
      items: {}, connectors: {}, endpoints: captureOptionalContainerEndpoints(state, groups.map(group => `group:${group.itemId}`)),
    } };
}
