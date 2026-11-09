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

// 成员全部离开的组合不再有可绑定轮廓：删除计划与剪切捕获必须共用这一判定，
// 否则捕获到存活父容器的端点依赖、事务内却不会移除它，合法命令会被判成 VERSION_CONFLICT。
export function emptiedGroupIds(groups: { id: string; memberItemIds: string[] }[], removed: Set<string>) {
  return groups.filter(group => group.memberItemIds.every(id => removed.has(id))).map(group => group.id);
}
