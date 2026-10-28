import type { Command, ProjectState } from './api';
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';
import type { MembershipDependency } from '../../backend/src/mapping/containment-contracts';

export function membershipExpected(state: ProjectState, itemId: string): MembershipDependency | undefined {
  const membership = state.containment?.find(value => value.id === itemId);
  const group = membership?.parent && state.groups?.find(value => value.itemId === membership.parent!.id);
  return group ? { group: { id: group.id, versionId: group.versionId }, containment: membership!.versionId } : undefined;
}

export function captureMemberDeletion(state: ProjectState, value: ReturnType<typeof canvasItems>[number], projectId = state.project.id) {
  if (!state.groups || !state.containment || !state.connectors || state.project.id !== projectId) return null;
  const visible = canvasItems(state).find(item => item.id === value.id && item.item.id === value.item.id);
  if (!visible || visible.versionId !== value.versionId || visible.item.versionId !== value.item.versionId) return null;
  const membership = membershipExpected(state, value.item.id);
  if (state.containment.some(item => item.id === value.item.id && item.parent) && !membership) return null;
  return { membership, connectors: Object.fromEntries(state.connectors.filter(line =>
    line.start.kind === 'bound' && line.start.itemId === value.item.id || line.end.kind === 'bound' && line.end.itemId === value.item.id,
  ).map(line => [line.id, line.versionId])) };
}

export function removeMemberCommand(state: ProjectState, itemId: string): Extract<Command, { type: 'group.remove-member' }> | null {
  const membership = membershipExpected(state, itemId);
  return membership ? { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'group.remove-member',
    expected: { group: membership.group.versionId, containment: membership.containment }, payload: { id: membership.group.id, itemId } } : null;
}

export function ungroupCommand(state: ProjectState, id: string): Extract<Command, { type: 'group.ungroup' }> | null {
  const group = state.groups?.find(value => value.id === id);
  return group ? { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'group.ungroup',
    expected: { group: group.versionId, containment: Object.fromEntries(state.containment!.filter(value => value.parent?.id === group.itemId).map(value => [value.id, value.versionId])) },
    payload: { id } } : null;
}

export function createGroupCommand(state: ProjectState, selection: CanvasSelection): Extract<Command, { type: 'group.create' }> {
  const id = crypto.randomUUID(), members = selectedItemIds(state, selection);
  const affected = state.groups?.filter(g => g.memberItemIds.some(itemId => members.includes(itemId))) ?? [];
  return { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'group.create',
    expected: { groups: { [id]: null, ...Object.fromEntries(affected.map(g => [g.id, g.versionId])) },
      containment: Object.fromEntries(members.map(itemId => [itemId, state.containment?.find(c => c.id === itemId)?.versionId ?? null])) },
    payload: { id, itemIds: selection.targets.map(t => t.kind === 'item' ? t.itemId : state.groups!.find(g => g.id === t.id)!.itemId) } };
}
