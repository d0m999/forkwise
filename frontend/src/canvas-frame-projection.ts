import type { CanvasFrame } from '../../backend/src/mapping/frame-contracts';
import type { CompactPage, FrameIndex } from '../../backend/src/mapping/compact-contracts';
import type { Containment } from '../../backend/src/mapping/group-contracts';

export function frameProjection(
  snapshot: { snapshot: string; revision: number },
  frames: { first: CompactPage<FrameIndex>; items: FrameIndex[] },
  containment: { first: CompactPage<Containment>; items: Containment[] },
  liveItemIds: Set<string>,
) {
  if (frames.first.revision !== snapshot.revision || frames.first.snapshot !== snapshot.snapshot)
    throw new Error('分区索引与地图快照不一致，请重新读取');
  const frameIds = new Set(frames.items.map(frame => frame.id));
  const liveIds = new Set([...liveItemIds, ...frameIds]);
  if (containment.items.some(value => !liveIds.has(value.id) || value.parent?.kind === 'frame' && !frameIds.has(value.parent.id)))
    throw new Error('分区成员归属不完整，请重新读取');
  const projected: CanvasFrame[] = frames.items.map(({ type: _type, memberCount, ...frame }) => {
    const memberItemIds = containment.items.filter(value => value.parent?.kind === 'frame' && value.parent.id === frame.id).map(value => value.id);
    if (memberCount !== memberItemIds.length) throw new Error('分区成员数量与快照不一致，请重新读取');
    return { ...frame, kind: 'frame', memberItemIds };
  });
  return { frames: projected };
}
