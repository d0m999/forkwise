import type { CanvasGroup, Containment } from '../../backend/src/mapping/group-contracts';
import type { CompactPage, GroupIndex } from '../../backend/src/mapping/compact-contracts';

export type { Containment, GroupIndex };
export function groupProjection(
  snapshot: { snapshot: string; revision: number },
  groups: { first: CompactPage<GroupIndex>; items: GroupIndex[] },
  containment: { first: CompactPage<Containment>; items: Containment[] },
  items: { item: { id: string; createdOrder?: number } }[],
) {
  for (const page of [groups, containment])
    if (page.first.revision !== snapshot.revision || page.first.snapshot !== snapshot.snapshot)
      throw new Error('组合归属与地图快照不一致，请重新读取');
  const ordered = [...items].sort((a, b) => (a.item.createdOrder ?? 0) - (b.item.createdOrder ?? 0));
  const liveIds = new Set(ordered.map(value => value.item.id));
  if (new Set(containment.items.map(value => value.id)).size !== containment.items.length ||
    containment.items.some(value => !liveIds.has(value.id) || value.parent?.kind === 'group' && !groups.items.some(g => g.itemId === value.parent!.id)))
    throw new Error('组合成员归属不完整，请重新读取');
  const projected: CanvasGroup[] = groups.items.map(({ type: _type, memberCount, ...group }) => {
    const members = new Set(containment.items.filter(c => c.parent?.kind === 'group' && c.parent.id === group.itemId).map(c => c.id));
    const memberItemIds = ordered.filter(value => members.has(value.item.id)).map(value => value.item.id);
    if (memberCount !== memberItemIds.length) throw new Error('组合成员数量与快照不一致，请重新读取');
    return { ...group, kind: 'group', memberItemIds };
  });
  return { groups: projected, containment: containment.items };
}
