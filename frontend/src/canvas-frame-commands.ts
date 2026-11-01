import type { Command, ProjectState } from './api';
import type { CanvasFrame } from '../../backend/src/mapping/frame-contracts';
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';

export type FrameRect = { x: number; y: number; width: number; height: number };

export function frameItemsInRect(state: ProjectState, rect: FrameRect) {
  const contains = (item: ReturnType<typeof canvasItems>[number]) => {
    const pose = item.item.pose;
    return pose.x >= rect.x && pose.y >= rect.y && pose.x + pose.width <= rect.x + rect.width &&
      pose.y + pose.height <= rect.y + rect.height;
  };
  const directIds: string[] = [], emittedGroups = new Set<string>();
  for (const item of canvasItems(state)) {
    const group = state.groups?.find(value => value.memberItemIds.includes(item.item.id));
    if (group) {
      if (emittedGroups.has(group.id)) continue;
      emittedGroups.add(group.id);
      if (!state.containment?.some(value => value.id === group.itemId && value.parent) &&
        canvasItems(state).filter(value => group.memberItemIds.includes(value.item.id)).every(contains)) directIds.push(group.itemId);
      continue;
    }
    if (!state.containment?.some(value => value.id === item.item.id && value.parent) && contains(item)) directIds.push(item.item.id);
  }
  return directIds;
}

export function createFrameCommand(state: ProjectState, itemIds: string[], pose: FrameRect): Extract<Command, { type: 'frame.create' }> {
  const groups = state.groups?.filter(group => itemIds.includes(group.itemId)) ?? [];
  const ordinaryIds = [...new Set(itemIds.flatMap(id => groups.find(group => group.itemId === id)?.memberItemIds ?? [id]))];
  return {
    commandId: crypto.randomUUID(), projectId: state.project.id, type: 'frame.create',
    expected: {
      frame: null,
      groups: Object.fromEntries(groups.map(group => [group.id, group.versionId])),
      containment: Object.fromEntries(itemIds.map(id => [id, state.containment?.find(value => value.id === id)?.versionId ?? null])),
      poses: Object.fromEntries(ordinaryIds.map(id => [id, canvasItems(state).find(value => value.item.id === id)!.item.versionId])),
    },
    payload: { id: crypto.randomUUID(), itemIds, pose },
  };
}

export function createFrameSelectionCommand(state: ProjectState, selection: CanvasSelection) {
  if (!selection.targets.length) return null;
  const itemIds = selection.targets.map(target => target.kind === 'item' ? target.itemId
    : state.groups?.find(group => group.id === target.id)?.itemId ?? '');
  if (itemIds.some(id => !id || state.containment?.some(value => value.id === id && value.parent))) return null;
  const selected = new Set(selectedItemIds(state, selection));
  const poses = canvasItems(state).filter(value => selected.has(value.item.id)).map(value => value.item.pose);
  if (poses.length !== selected.size) return null;
  const x = Math.min(...poses.map(pose => pose.x)) - 24, y = Math.min(...poses.map(pose => pose.y)) - 24;
  const right = Math.max(...poses.map(pose => pose.x + pose.width)) + 24;
  const bottom = Math.max(...poses.map(pose => pose.y + pose.height)) + 24;
  return createFrameCommand(state, itemIds, { x, y, width: right - x, height: bottom - y });
}

export function frameMovingItemIds(state: ProjectState, frame: CanvasFrame) {
  return [...new Set(frame.memberItemIds.flatMap(id => state.groups?.find(group => group.itemId === id)?.memberItemIds ?? [id]))];
}

export function moveFrameCommand(state: ProjectState, frame: CanvasFrame, dx: number, dy: number): Extract<Command, { type: 'frame.move' }> {
  const groups = state.groups?.filter(group => frame.memberItemIds.includes(group.itemId)) ?? [];
  const ordinaryIds = frameMovingItemIds(state, frame);
  const affectedMemberships = new Set([...frame.memberItemIds, ...ordinaryIds]);
  return {
    commandId: crypto.randomUUID(), projectId: state.project.id, type: 'frame.move',
    expected: {
      frame: frame.versionId,
      groups: Object.fromEntries(groups.map(group => [group.id, group.versionId])),
      containment: Object.fromEntries(state.containment?.filter(value => affectedMemberships.has(value.id)).map(value => [value.id, value.versionId]) ?? []),
      poses: Object.fromEntries(ordinaryIds.map(id => [id, canvasItems(state).find(value => value.item.id === id)!.item.versionId])),
    },
    payload: { id: frame.id, dx, dy },
  };
}

export function deleteFrameCommand(state: ProjectState, frame: CanvasFrame): Extract<Command, { type: 'frame.delete' }> {
  return {
    commandId: crypto.randomUUID(), projectId: state.project.id, type: 'frame.delete',
    expected: {
      frame: frame.versionId,
      containment: Object.fromEntries(state.containment?.filter(value => value.parent?.kind === 'frame' && value.parent.id === frame.id)
        .map(value => [value.id, value.versionId]) ?? []),
    },
    payload: { id: frame.id },
  };
}
