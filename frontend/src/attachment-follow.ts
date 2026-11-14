import type { Card, ProjectState } from './api';

type Pose = { x: number; y: number; width?: number; height?: number };
type Motion = { itemId: string; dx: number; dy: number };

function annotations(state: ProjectState) {
  return [
    ...(state.texts ?? []).map(value => ({ kind: 'text' as const, id: value.id, itemId: value.item.id, x: value.item.pose.x, y: value.item.pose.y, versionId: value.item.versionId })),
    ...(state.shapes ?? []).map(value => ({ kind: 'shape' as const, id: value.id, itemId: value.item.id, x: value.item.pose.x, y: value.item.pose.y, versionId: value.item.versionId })),
    ...(state.images ?? []).map(value => ({ kind: 'image' as const, id: value.id, itemId: value.item.id, x: value.item.pose.x, y: value.item.pose.y, versionId: value.item.versionId })),
    ...(state.strokes ?? []).map(value => ({ kind: 'stroke' as const, id: value.id, itemId: value.item.id, x: value.item.pose.x, y: value.item.pose.y, versionId: value.item.versionId })),
  ];
}

export function followerFields(state: ProjectState, motions: readonly Motion[], movingItemIds: ReadonlySet<string>) {
  const changed = new Map(motions.filter(value => value.dx !== 0 || value.dy !== 0).map(value => [value.itemId, value]));
  const required = (state.attachments ?? []).filter(row => row.target && changed.has(row.target.itemId) && !movingItemIds.has(row.id));
  if (!required.length) return {};
  const known = annotations(state);
  const followers = required.flatMap(row => {
    const annotation = known.find(value => value.itemId === row.id);
    const motion = changed.get(row.target!.itemId);
    if (!annotation || !motion) return [];
    return [{ kind: annotation.kind, id: annotation.id, itemId: annotation.itemId, x: annotation.x + motion.dx, y: annotation.y + motion.dy }];
  });
  return {
    followers,
    expectedFollowers: Object.fromEntries(followers.map(value => [value.itemId, known.find(item => item.itemId === value.itemId)!.versionId])),
  };
}

export function batchMotions(cards: readonly Card[], poses: readonly { x: number; y: number; width: number; height: number }[]): Motion[] {
  return cards.flatMap((card, index) => {
    const pose = poses[index]!;
    const current = card.item.pose;
    if (pose.x === current.x && pose.y === current.y && pose.width === current.width && pose.height === current.height) return [];
    const height = Math.max(pose.height, card.item.heightPolicy?.necessaryHeight ?? 0);
    const dx = pose.x + pose.width / 2 - (current.x + current.width / 2);
    const dy = pose.y + height / 2 - (current.y + current.height / 2);
    return dx === 0 && dy === 0 ? [] : [{ itemId: card.item.id, dx, dy }];
  });
}

export function attachmentPreviewPositions(state: ProjectState, sources: { pose: Record<string, Pose>; canvas: Record<string, Pose>; frame: Record<string, Pose>; geometry: Record<string, Pose> }) {
  const known = annotations(state);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const row of state.attachments ?? []) {
    if (!row.target || sources.canvas[row.id] || sources.frame[row.id] || sources.geometry[row.id]) continue;
    const card = state.cards.find(value => value.item.id === row.target!.itemId);
    const annotation = known.find(value => value.itemId === row.id);
    if (!card || !annotation) continue;
    const preview = sources.geometry[card.item.id] ?? sources.frame[card.item.id] ?? sources.canvas[card.item.id] ?? sources.pose[card.item.id];
    if (!preview) continue;
    const width = preview.width ?? card.item.pose.width;
    const height = preview.height ?? card.item.pose.height;
    const dx = preview.x + width / 2 - (card.item.pose.x + card.item.pose.width / 2);
    const dy = preview.y + height / 2 - (card.item.pose.y + card.item.pose.height / 2);
    if (dx === 0 && dy === 0) continue;
    positions[row.id] = { x: annotation.x + dx, y: annotation.y + dy };
  }
  return positions;
}
