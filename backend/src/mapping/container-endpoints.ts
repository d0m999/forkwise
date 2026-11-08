import { z } from 'zod';
import type { CanvasConnector, ConnectorEndpoint, EndpointKind } from './connector-contracts.js';
import { endpointKey } from './connector-contracts.js';
import type { CanvasGroup, Containment } from './group-contracts.js';
import type { CanvasFrame } from './frame-contracts.js';

type Box = { x: number; y: number; width: number; height: number };
export const GROUP_OUTLINE_PADDING = 10;
export function groupOutlineBounds(poses: Box[]): Box {
  const x = Math.min(...poses.map(p => p.x)) - GROUP_OUTLINE_PADDING;
  const y = Math.min(...poses.map(p => p.y)) - GROUP_OUTLINE_PADDING;
  return { x, y, width: Math.max(...poses.map(p => p.x + p.width)) + GROUP_OUTLINE_PADDING - x,
    height: Math.max(...poses.map(p => p.y + p.height)) + GROUP_OUTLINE_PADDING - y };
}
export function sidePoint(pose: Box, side: 'top' | 'right' | 'bottom' | 'left') {
  if (side === 'top') return { x: pose.x + pose.width / 2, y: pose.y };
  if (side === 'right') return { x: pose.x + pose.width, y: pose.y + pose.height / 2 };
  if (side === 'bottom') return { x: pose.x + pose.width / 2, y: pose.y + pose.height };
  return { x: pose.x, y: pose.y + pose.height / 2 };
}
const Id = z.string().min(1).max(160);
export const ContainerEndpointExpected = z.object({
  connectors: z.record(Id, Id), groups: z.record(Id, Id), frames: z.record(Id, Id),
  containment: z.record(Id, Id.nullable()), poses: z.record(Id, Id),
}).strict();
export type ContainerEndpointDependencies = z.infer<typeof ContainerEndpointExpected>;
export type EndpointState = {
  groups?: CanvasGroup[]; frames?: CanvasFrame[]; containment?: Containment[]; connectors?: CanvasConnector[];
  cards: { item: { id: string; versionId: string; pose: Box } }[];
  texts?: EndpointState['cards']; shapes?: EndpointState['cards']; images?: EndpointState['cards']; strokes?: EndpointState['cards'];
};
function ownedItems(state: EndpointState) {
  return [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? []), ...(state.strokes ?? [])];
}
export function endpointBounds(state: EndpointState, endpoint: Extract<ConnectorEndpoint, { kind: 'bound' }>): Box | null {
  if (endpoint.targetKind === 'frame') return state.frames?.find(frame => frame.id === endpoint.itemId)?.pose ?? null;
  const items = ownedItems(state);
  if (endpoint.targetKind === 'group') {
    const group = state.groups?.find(group => group.itemId === endpoint.itemId);
    return group ? groupOutlineBounds(items.filter(value => group.memberItemIds.includes(value.item.id)).map(value => value.item.pose)) : null;
  }
  return items.find(value => value.item.id === endpoint.itemId)?.item.pose ?? null;
}
// 外端内容指纹：判定「冻结之后这个外端有没有被改动」。组合轮廓由成员 pose 派生
// （见 groupOutlineBounds），成员移动不会换组合版本，因此组合必须把成员 pose 版本一并纳入。
// 与 captureContainerEndpoints 并存：后者校验单次命令自带的期望值（含被删连线版本），
// 本函数只取存续端点、可跨任意时间比对，两者口径不同不能合并。
export function endpointFingerprint(state: EndpointState, targetKind: EndpointKind, itemId: string): string | null {
  if (targetKind === 'frame') return state.frames?.find(frame => frame.id === itemId)?.versionId ?? null;
  const items = ownedItems(state);
  if (targetKind === 'group') {
    const group = state.groups?.find(value => value.itemId === itemId);
    if (!group) return null;
    const memberPoses = group.memberItemIds.map(id => `${id}:${items.find(value => value.item.id === id)?.item.versionId ?? '-'}`).sort();
    return [group.versionId, ...memberPoses].join('|');
  }
  return items.find(value => value.item.id === itemId)?.item.versionId ?? null;
}

// The same captured dependency vocabulary is used by UI commands and the transaction planner.
export function captureContainerEndpoints(state: EndpointState, keys: string[]): ContainerEndpointDependencies {
  const wanted = new Set(keys);
  const lines = (state.connectors ?? []).filter(line => [line.start, line.end].some(end => end.kind === 'bound' && wanted.has(endpointKey(end))));
  const used = new Set(lines.flatMap(line => [line.start, line.end].flatMap(end => end.kind === 'bound' && wanted.has(endpointKey(end)) ? [endpointKey(end)] : [])));
  const groups = (state.groups ?? []).filter(group => used.has(`group:${group.itemId}`));
  const frames = (state.frames ?? []).filter(frame => used.has(`frame:${frame.id}`));
  const memberIds = new Set(groups.flatMap(group => group.memberItemIds));
  const membershipIds = new Set([...memberIds, ...groups.map(group => group.itemId), ...frames.flatMap(frame => frame.memberItemIds)]);
  const items = ownedItems(state);
  return {
    connectors: Object.fromEntries(lines.map(line => [line.id, line.versionId])),
    groups: Object.fromEntries(groups.map(group => [group.id, group.versionId])),
    frames: Object.fromEntries(frames.map(frame => [frame.id, frame.versionId])),
    containment: Object.fromEntries([...membershipIds].map(id => [id, state.containment?.find(value => value.id === id)?.versionId ?? null])),
    poses: Object.fromEntries(items.filter(value => memberIds.has(value.item.id)).map(value => [value.item.id, value.item.versionId])),
  };
}

// Keep existing command DTOs unchanged when no container incident needs a read dependency.
export function captureOptionalContainerEndpoints(state: EndpointState, keys: string[]) {
  const captured = captureContainerEndpoints(state, keys);
  return Object.keys(captured.connectors).length ? captured : undefined;
}
