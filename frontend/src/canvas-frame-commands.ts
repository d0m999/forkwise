import { captureSpatial, frameDescendants, frameRoots, containsRect, frameCreationParent, frameDrawMembers } from '../../backend/src/mapping/frame-spatial';
import { captureOptionalContainerEndpoints } from '../../backend/src/mapping/container-endpoints';
import type { Command, ProjectState } from './api';
import type { CanvasFrame } from '../../backend/src/mapping/frame-contracts';
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';
import { followerFields } from './attachment-follow';

export type FrameRect = { x: number; y: number; width: number; height: number };

export function frameItemsInRect(state: ProjectState, rect: FrameRect) {
  return frameDrawMembers(state, rect);
}

export function createFrameCommand(state: ProjectState, itemIds: string[], pose: FrameRect): Extract<Command, { type: 'frame.create' }> {
  const groups = state.groups?.filter(group => itemIds.includes(group.itemId)) ?? [];
  const ordinaryIds = [...new Set(itemIds.flatMap(id => groups.find(group => group.itemId === id)?.memberItemIds ?? (state.frames?.some(v => v.id === id) ? [] : [id])))];
  return {
    commandId: crypto.randomUUID(), projectId: state.project.id, type: 'frame.create',
    expected: {
      frame: null,
      groups: Object.fromEntries(groups.map(group => [group.id, group.versionId])),
      containment: Object.fromEntries(itemIds.map(id => [id, state.containment?.find(value => value.id === id)?.versionId ?? null])),
      poses: Object.fromEntries(ordinaryIds.map(id => [id, canvasItems(state).find(value => value.item.id === id)!.item.versionId])),
    },
    placement: { expected: captureSpatial(state, { rect: pose }) },
    payload: { id: crypto.randomUUID(), itemIds, pose },
  };
}

export function createFrameSelectionCommand(state: ProjectState, selection: CanvasSelection) {
  if (!selection.targets.length) return null;
  const itemIds = selection.targets.map(target => target.kind === 'item' ? target.itemId
    : state.groups?.find(group => group.id === target.id)?.itemId ?? '');
  if (itemIds.some(id => !id || state.containment?.find(value => value.id === id)?.parent?.kind === 'group')) return null;
  const parents = itemIds.map(id => state.containment?.find(v => v.id === id)?.parent?.id ?? null);
  if (!parents.every(id => id === parents[0])) return null;
  const selected = new Set(selectedItemIds(state, selection));
  const poses = canvasItems(state).filter(value => selected.has(value.item.id)).map(value => value.item.pose);
  if (poses.length !== selected.size) return null;
  const x = Math.min(...poses.map(pose => pose.x)) - 24, y = Math.min(...poses.map(pose => pose.y)) - 24;
  const right = Math.max(...poses.map(pose => pose.x + pose.width)) + 24;
  const bottom = Math.max(...poses.map(pose => pose.y + pose.height)) + 24;
  const command = createFrameCommand(state, itemIds, { x, y, width: right - x, height: bottom - y });
  command.payload.parentId = parents[0] ?? null;
  command.placement = { expected: captureSpatial(state, { itemIds }) };
  return command;
}

export function frameMovingItemIds(state: ProjectState, frame: CanvasFrame) {
  const frames = frameDescendants(state, [frame.id]);
  const direct = state.containment?.filter(value => value.parent?.kind === 'frame' && frames.has(value.parent.id)).map(value => value.id) ?? [];
  return [...new Set(direct.flatMap(id => state.groups?.find(group => group.itemId === id)?.memberItemIds ?? (frames.has(id) ? [] : [id])))];
}

export function moveFrameCommand(state: ProjectState, frame: CanvasFrame, dx: number, dy: number, point?: { x: number; y: number }): Extract<Command, { type: 'frame.move' }> {
  const frames = frameDescendants(state, [frame.id]);
  const directIds = state.containment?.filter(v => v.parent?.kind === 'frame' && frames.has(v.parent.id)).map(v => v.id) ?? [];
  const groups = state.groups?.filter(group => directIds.includes(group.itemId)) ?? [];
  const ordinaryIds = frameMovingItemIds(state, frame);
  const affectedMemberships = new Set([...directIds, ...ordinaryIds]);
  const moving = new Set(ordinaryIds.filter(id => !state.cards.some(card => card.item.id === id)));
  return {
    commandId: crypto.randomUUID(), projectId: state.project.id, type: 'frame.move',
    ...(dx === 0 && dy === 0 ? {} : followerFields(state, ordinaryIds.flatMap(id => state.cards.some(card => card.item.id === id) ? [{ itemId: id, dx, dy }] : []), moving)),
    expected: {
      frame: frame.versionId,
      groups: Object.fromEntries(groups.map(group => [group.id, group.versionId])),
      containment: Object.fromEntries(state.containment?.filter(value => affectedMemberships.has(value.id)).map(value => [value.id, value.versionId]) ?? []),
      poses: Object.fromEntries(ordinaryIds.map(id => [id, canvasItems(state).find(value => value.item.id === id)!.item.versionId])),
    },
    placement: { expected: captureSpatial(state), ...(point ? { point } : {}) },
    payload: { id: frame.id, dx, dy },
  };
}

export function deleteFrameCommand(state: ProjectState, frame: CanvasFrame): Extract<Command, { type: 'frame.delete' }> {
  return {
    commandId: crypto.randomUUID(), projectId: state.project.id, type: 'frame.delete',
    expected: {
      frame: frame.versionId,
      endpoints: captureOptionalContainerEndpoints(state, [`frame:${frame.id}`]),
      containment: Object.fromEntries(state.containment?.filter(value => value.id === frame.id || value.parent?.kind === 'frame' && value.parent.id === frame.id)
        .map(value => [value.id, value.versionId]) ?? []),
    },
    payload: { id: frame.id },
  };
}

export const frameHandleNames = { nw: '左上角', n: '上边缘', ne: '右上角', e: '右边缘', se: '右下角', s: '下边缘', sw: '左下角', w: '左边缘' };
export function resizedFrameRect(pose: FrameRect, corner: string, dx: number, dy: number): FrameRect {
  const west = corner.includes('w'), east = corner.includes('e'), north = corner.includes('n'), south = corner.includes('s');
  const x = west ? Math.min(pose.x + pose.width - 20, pose.x + dx) : pose.x;
  const y = north ? Math.min(pose.y + pose.height - 20, pose.y + dy) : pose.y;
  return { x, y, width: west ? pose.x + pose.width - x : east ? Math.max(20, pose.width + dx) : pose.width,
    height: north ? pose.y + pose.height - y : south ? Math.max(20, pose.height + dy) : pose.height };
}
