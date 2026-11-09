import { captureOptionalContainerEndpoints } from './container-endpoints.js';
import { emptiedGroups, emptiedGroupKeys } from './snapshot-tree.js';
import type { CanvasConnector } from './connector-contracts.js';
import type { Card } from './contracts.js';
import type { CanvasFrame } from './frame-contracts.js';
import type { CanvasGroup, Containment } from './group-contracts.js';
import type { CanvasCut } from './cut-contracts.js';
import type { CanvasImage } from './image-contracts.js';
import type { CanvasShape } from './shape-contracts.js';
import type { CanvasStroke } from './stroke-contracts.js';
import type { CanvasText } from './text-contracts.js';

// 剪切范围在前端就已冻结成完整子树；这里只把同一份范围翻译成可校验的删除事实。
// 组合/分区的显式参数保持“整段被剪切”的语义，校验集合则可以包含受影响的父容器。
type ScopeState = {
  cards: Card[];
  texts?: CanvasText[];
  shapes?: CanvasShape[];
  images?: CanvasImage[];
  strokes?: CanvasStroke[];
  groups?: CanvasGroup[];
  frames?: CanvasFrame[];
  containment?: Containment[];
  connectors?: CanvasConnector[];
};
export type CutScopeInput = {
  commandId: string;
  projectId: string;
  cutId: string;
  itemIds: string[];
  groupIds: string[];
  frameIds: string[];
};

export function captureCutCommand(state: ScopeState, input: CutScopeInput): CanvasCut {
  const groups = state.groups ?? [], frames = state.frames ?? [], containment = state.containment ?? [], connectors = state.connectors ?? [];
  const items = new Set(input.itemIds);
  for (const id of input.groupIds) {
    const group = groups.find(value => value.id === id);
    if (!group) throw new Error('剪切目标组合已变化，请重新读取');
    for (const member of group.memberItemIds) items.add(member);
  }
  const cutFrameIds = new Set(input.frameIds);
  for (const id of cutFrameIds) if (!frames.some(frame => frame.id === id)) throw new Error('剪切目标分区已变化，请重新读取');
  const affectedGroups = new Set(input.groupIds), affectedFrames = new Set(cutFrameIds), membership = new Set(items);
  // 嵌套分区自身也有归属行：删选会把 payload.frameIds 的行计入校验集合，这里必须同步。
  for (const id of cutFrameIds) if (containment.some(value => value.id === id)) membership.add(id);
  for (const id of items) {
    const parent = containment.find(value => value.id === id)?.parent;
    if (!parent) continue;
    if (parent.kind === 'frame') { affectedFrames.add(parent.id); continue; }
    const group = groups.find(value => value.itemId === parent.id);
    if (!group) throw new Error('剪切对象所属组合已变化，请重新读取');
    affectedGroups.add(group.id);
  }
  for (const group of emptiedGroups(groups.filter(value => affectedGroups.has(value.id)), items)) {
    const own = containment.find(value => value.id === group.itemId);
    if (own) membership.add(group.itemId);
    if (own?.parent?.kind === 'frame') affectedFrames.add(own.parent.id);
  }
  const itemsExpected: CanvasCut['expected']['items'] = {};
  for (const card of state.cards) if (items.has(card.item.id)) itemsExpected[card.item.id] = {
    kind: 'card', thought: card.versionId, body: card.body.versionId, pose: card.item.versionId,
    appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null,
  };
  for (const value of state.texts ?? []) if (items.has(value.item.id)) itemsExpected[value.item.id] = { kind: 'text', text: value.versionId, pose: value.item.versionId };
  for (const value of state.shapes ?? []) if (items.has(value.item.id)) itemsExpected[value.item.id] = { kind: 'shape', shape: value.versionId, pose: value.item.versionId };
  for (const value of state.images ?? []) if (items.has(value.item.id)) itemsExpected[value.item.id] = { kind: 'image', image: value.versionId, pose: value.item.versionId };
  for (const value of state.strokes ?? []) if (items.has(value.item.id)) itemsExpected[value.item.id] = { kind: 'stroke', stroke: value.versionId, pose: value.item.versionId };
  if (Object.keys(itemsExpected).length !== items.size) throw new Error('剪切目标不完整，请重新读取');
  if ([...affectedGroups].some(id => !groups.some(group => group.id === id)) || [...affectedFrames].some(id => !frames.some(frame => frame.id === id)))
    throw new Error('剪切目标的容器归属已变化，请重新读取');
  const incident = connectors.filter(line => [line.start, line.end].some(end =>
    end.kind === 'bound' && (end.targetKind ?? 'item') === 'item' && items.has(end.itemId)));
  // 端点依赖只覆盖本次真正移除的容器：存活父容器上的外线不随本次剪切变化，
  // 若把它算入 captured，事务内的移除计划不会包含它，合法剪切会被整体判成 VERSION_CONFLICT。
  // 父容器与归属的必要版本校验仍由 expected.groups / frames / containment 承担。
  const containerKeys = [...new Set([
    ...groups.filter(group => input.groupIds.includes(group.id)).map(group => `group:${group.itemId}`),
    ...emptiedGroupKeys(groups, items),
    ...[...cutFrameIds].map(id => `frame:${id}`),
  ])];
  const endpoints = captureOptionalContainerEndpoints({ ...state, connectors }, containerKeys);
  return {
    commandId: input.commandId,
    projectId: input.projectId,
    type: 'canvas.cut',
    expected: {
      groups: Object.fromEntries([...affectedGroups].map(id => [id, groups.find(group => group.id === id)!.versionId])),
      ...(affectedFrames.size ? { frames: Object.fromEntries([...affectedFrames].map(id => [id, frames.find(frame => frame.id === id)!.versionId])) } : {}),
      containment: Object.fromEntries([...membership].map(id => [id, containment.find(value => value.id === id)?.versionId ?? null])),
      items: itemsExpected,
      connectors: Object.fromEntries(incident.map(line => [line.id, line.versionId])),
      ...(endpoints ? { endpoints } : {}),
    },
    payload: {
      cutId: input.cutId,
      groupIds: [...input.groupIds],
      itemIds: [...items],
      ...(cutFrameIds.size ? { frameIds: [...cutFrameIds] } : {}),
    },
  };
}
