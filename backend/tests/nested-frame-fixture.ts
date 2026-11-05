import { randomUUID } from 'node:crypto';
import type { ProjectState } from '../src/mapping/contracts.js';
import { captureSpatial, frameDescendants, spatialItems, type Rect } from '../src/mapping/frame-spatial.js';
import type { CanvasFrame } from '../src/mapping/frame-contracts.js';
export function createFrameCommand(state: ProjectState, itemIds: string[], pose: Rect) {
  const groups = state.groups!.filter(group => itemIds.includes(group.itemId));
  const ordinary = itemIds.flatMap(id => groups.find(v => v.itemId === id)?.memberItemIds ?? (state.frames!.some(v => v.id === id) ? [] : [id]));
  return { commandId: randomUUID(), projectId: state.project.id, type: 'frame.create', placement: { expected: captureSpatial(state, { rect: pose }) },
    expected: { frame: null, groups: Object.fromEntries(groups.map(v => [v.id, v.versionId])),
      containment: Object.fromEntries(itemIds.map(id => [id, state.containment!.find(v => v.id === id)?.versionId ?? null])),
      poses: Object.fromEntries(ordinary.map(id => [id, spatialItems(state).find(v => v.item.id === id)!.item.versionId])) },
    payload: { id: randomUUID(), itemIds, pose } };
}
export function moveFrameCommand(state: ProjectState, frame: CanvasFrame, dx: number, dy: number) {
  const frames = frameDescendants(state, [frame.id]);
  const direct = state.containment!.filter(v => v.parent?.kind === 'frame' && frames.has(v.parent.id));
  const groups = state.groups!.filter(g => direct.some(v => v.id === g.itemId));
  const contained = state.containment!.filter(v => direct.some(d => d.id === v.id) || v.parent?.kind === 'group' && groups.some(g => v.parent!.id === g.itemId));
  const ordinary = spatialItems(state).filter(v => contained.some(c => c.id === v.item.id));
  return { commandId: randomUUID(), projectId: state.project.id, type: 'frame.move', placement: { expected: captureSpatial(state), point: undefined as { x: number; y: number } | undefined },
    expected: { frame: frame.versionId, groups: Object.fromEntries(groups.map(v => [v.id, v.versionId])),
      containment: Object.fromEntries(contained.map(v => [v.id, v.versionId])), poses: Object.fromEntries(ordinary.map(v => [v.item.id, v.item.versionId])) },
    payload: { id: frame.id, dx, dy } };
}
