import { normalizeFrameRoots, type SpatialState } from './frame-spatial.js';

// Container identity is its canvas identity: group.itemId, frame.id, or ordinary item.id.
export function snapshotScope(state: SpatialState, selected: string[]) {
  const roots = normalizeFrameRoots(state, selected), ids = new Set(roots);
  const containers = new Set([...(state.groups ?? []).map(v => v.itemId), ...(state.frames ?? []).map(v => v.id)]);
  const visit = (id: string) => {
    if (!containers.has(id)) return;
    for (const edge of state.containment ?? []) if (edge.parent?.id === id && !ids.has(edge.id)) {
      ids.add(edge.id); visit(edge.id);
    }
  };
  for (const id of roots) visit(id);
  return { roots, ids };
}
