import { z } from 'zod';
import type { CanvasFrame } from './frame-contracts.js';
import type { CanvasGroup, Containment } from './group-contracts.js';

const Id = z.string().min(1).max(160);
export const SpatialExpected = z.object({
  frames: z.record(Id, Id), groups: z.record(Id, Id),
  containment: z.record(Id, Id), poses: z.record(Id, Id),
}).strict();
export const FramePlacement = z.object({
  expected: SpatialExpected,
  point: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
}).strict();
export type Rect = { x: number; y: number; width: number; height: number };
type Item = { item: { id: string; versionId: string; pose: Rect } };
export type SpatialState = {
  frames?: CanvasFrame[]; groups?: CanvasGroup[]; containment?: Containment[];
  cards: Item[]; texts?: Item[]; shapes?: Item[]; images?: Item[]; strokes?: Item[];
};
export function spatialItems(state: SpatialState) {
  return [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? []), ...(state.strokes ?? [])];
}
export function captureSpatial(state: SpatialState, scope?: { rect?: Rect; frameId?: string; itemIds?: string[] }): z.infer<typeof SpatialExpected> {
  let roots: Set<string> | undefined;
  if (scope) roots = new Set(scope.itemIds ?? (scope.frameId
    ? [...frameResizePlan(state, scope.frameId, scope.rect!).attach, ...frameResizePlan(state, scope.frameId, scope.rect!).release, scope.frameId]
    : frameDrawMembers(state, scope.rect!)));
  const groups = (state.groups ?? []).filter(v => !roots || roots.has(v.itemId));
  const itemIds = roots ? new Set([...roots, ...groups.flatMap(v => v.memberItemIds)]) : undefined;
  const frameIds = new Set((state.frames ?? []).map(v => v.id));
  return {
    frames: Object.fromEntries((state.frames ?? []).map(v => [v.id, v.versionId])),
    groups: Object.fromEntries(groups.map(v => [v.id, v.versionId])),
    containment: Object.fromEntries((state.containment ?? []).filter(v => !itemIds || itemIds.has(v.id) || frameIds.has(v.id)).map(v => [v.id, v.versionId])),
    poses: Object.fromEntries(spatialItems(state).filter(v => !itemIds || itemIds.has(v.item.id)).map(v => [v.item.id, v.item.versionId])),
  };
}
export function frameDescendants(state: SpatialState, roots: string[]) {
  const ids = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const frame of state.frames ?? []) {
      const parent = state.containment?.find(v => v.id === frame.id)?.parent;
      if (!ids.has(frame.id) && parent?.kind === 'frame' && ids.has(parent.id)) { ids.add(frame.id); changed = true; }
    }
  }
  return ids;
}
export function frameCandidate(state: SpatialState, point: { x: number; y: number }, excluded: string[] = []) {
  const omitted = frameDescendants(state, excluded);
  const candidates = (state.frames ?? []).filter(frame => !omitted.has(frame.id) &&
    point.x >= frame.pose.x && point.y >= frame.pose.y && point.x <= frame.pose.x + frame.pose.width && point.y <= frame.pose.y + frame.pose.height);
  // Eliminate ancestors first. Only then use the saved, actually rendered frame order.
  const leaves = candidates.filter(frame => !candidates.some(other => other.id !== frame.id && frameDescendants(state, [frame.id]).has(other.id)));
  return leaves.at(-1) ?? null;
}
export function containsRect(rect: Rect, pose: Rect) {
  return pose.x >= rect.x && pose.y >= rect.y && pose.x + pose.width <= rect.x + rect.width && pose.y + pose.height <= rect.y + rect.height;
}
export function frameRoots(state: SpatialState) {
  return [
    ...spatialItems(state).filter(v => !state.containment?.some(c => c.id === v.item.id && c.parent?.kind === 'group')).map(v => ({ id: v.item.id, pose: v.item.pose })),
    ...(state.groups ?? []).map(v => ({ id: v.itemId, pose: v.bounds })),
    ...(state.frames ?? []).map(v => ({ id: v.id, pose: v.pose })),
  ];
}
export function frameCreationParent(state: SpatialState, rect: Rect) {
  return frameCandidate(state, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    (state.frames ?? []).filter(v => containsRect(rect, v.pose)).map(v => v.id));
}

export function normalizeFrameRoots(state: SpatialState, ids: string[]) {
  const selected = new Set(ids);
  return [...selected].filter(id => {
    let parent = state.containment?.find(v => v.id === id)?.parent;
    while (parent) {
      if (selected.has(parent.id)) return false;
      parent = state.containment?.find(v => v.id === parent!.id)?.parent;
    }
    return true;
  });
}
export function frameAncestors(state: SpatialState, parentId: string | null) {
  const ancestors = new Set<string>();
  let id = parentId;
  while (id) {
    ancestors.add(id);
    const parent = state.containment?.find(v => v.id === id)?.parent;
    id = parent?.kind === 'frame' ? parent.id : null;
  }
  return ancestors;
}
export function frameResizePlan(state: SpatialState, frameId: string, rect: Rect) {
  const excluded = frameDescendants(state, [frameId]);
  const parent = state.containment?.find(v => v.id === frameId)?.parent;
  const ancestors = frameAncestors(state, parent?.kind === 'frame' ? parent.id : null);
  const frameIds = new Set((state.frames ?? []).map(v => v.id));
  const attach: string[] = [], release: string[] = [];
  for (const root of frameRoots(state)) {
    if (root.id === frameId || ancestors.has(root.id)) continue;
    const parent = state.containment?.find(v => v.id === root.id)?.parent ?? null;
    if (parent?.kind === 'frame' && parent.id === frameId) {
      const p = root.pose;
      if (p.x + p.width < rect.x || p.y + p.height < rect.y || p.x > rect.x + rect.width || p.y > rect.y + rect.height) release.push(root.id);
      else attach.push(root.id);
    } else if (!excluded.has(root.id) && (frameIds.has(root.id) || !parent || parent.kind === 'frame' && ancestors.has(parent.id)) && containsRect(rect, root.pose)) attach.push(root.id);
  }
  return { attach: normalizeFrameRoots(state, attach), release };
}
export function frameDrawMembers(state: SpatialState, rect: Rect) {
  const parent = frameCreationParent(state, rect), ancestors = frameAncestors(state, parent?.id ?? null);
  const frameIds = new Set((state.frames ?? []).map(v => v.id));
  return normalizeFrameRoots(state, frameRoots(state).filter(root => {
    const ownParent = state.containment?.find(v => v.id === root.id)?.parent;
    return (frameIds.has(root.id) || !ownParent || ownParent.kind === 'frame' && ancestors.has(ownParent.id)) && containsRect(rect, root.pose);
  }).map(root => root.id));
}
