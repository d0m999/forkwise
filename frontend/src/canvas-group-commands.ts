import type { Command, ProjectState } from './api';
import { selectedItemIds, type CanvasSelection } from './canvas-selection';

export function createGroupCommand(state: ProjectState, selection: CanvasSelection): Extract<Command, { type: 'group.create' }> {
  const id = crypto.randomUUID(), members = selectedItemIds(state, selection);
  const affected = state.groups?.filter(g => g.memberItemIds.some(itemId => members.includes(itemId))) ?? [];
  return { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'group.create',
    expected: { groups: { [id]: null, ...Object.fromEntries(affected.map(g => [g.id, g.versionId])) },
      containment: Object.fromEntries(members.map(itemId => [itemId, state.containment?.find(c => c.id === itemId)?.versionId ?? null])) },
    payload: { id, itemIds: selection.targets.map(t => t.kind === 'item' ? t.itemId : state.groups!.find(g => g.id === t.id)!.itemId) } };
}
