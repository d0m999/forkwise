import { endpointBounds, sidePoint, captureOptionalContainerEndpoints } from "../../backend/src/mapping/container-endpoints";
import { endpointKey, type ConnectorEndpoint } from "../../backend/src/mapping/connector-contracts";
import { CanvasClipboardSchema } from "../../backend/src/mapping/snapshot-contracts";
import { TAG_COLORS } from "../../backend/src/mapping/tag-contracts";
import { snapshotScope } from "../../backend/src/mapping/snapshot-tree";
export { sidePoint } from "../../backend/src/mapping/container-endpoints";
import type { Command, ProjectState } from "./api";
import type { CanvasSelection } from "./canvas-selection";
import { boundsCenter, type Point } from "./canvas-snapshot-geometry";

export const CANVAS_CLIPBOARD_TYPE = "web application/x-forkwise-canvas";
export type CanvasClipboardDocument = ReturnType<typeof CanvasClipboardSchema.parse>;
type FrozenObject = CanvasClipboardDocument['objects'][number];
type FrozenEnd = CanvasClipboardDocument['connectors'][number]['start'];
type Kind = FrozenObject['kind'];
type Located =
  | { kind: 'card'; value: ProjectState['cards'][number] }
  | { kind: 'text'; value: NonNullable<ProjectState['texts']>[number] }
  | { kind: 'shape'; value: NonNullable<ProjectState['shapes']>[number] }
  | { kind: 'image'; value: NonNullable<ProjectState['images']>[number] }
  | { kind: 'stroke'; value: NonNullable<ProjectState['strokes']>[number] };
export type CopyRef = { kind: Kind; copyId: string };
type Plan = { command: Command; objectCopyIds: CopyRef[]; connectorCopyIds: string[] };

function located(state: ProjectState): Located[] {
  return [...state.cards.map(value => ({ kind: 'card' as const, value })),
    ...(state.texts ?? []).map(value => ({ kind: 'text' as const, value })),
    ...(state.shapes ?? []).map(value => ({ kind: 'shape' as const, value })),
    ...(state.images ?? []).map(value => ({ kind: 'image' as const, value })),
    ...(state.strokes ?? []).map(value => ({ kind: 'stroke' as const, value }))];
}
function picked(state: ProjectState, selection: CanvasSelection, connectorIds: string[], frameIds: string[]) {
  const scope = snapshotScope(state, [...selection.targets.flatMap(target => target.kind === 'group'
    ? state.groups?.filter(v => v.id === target.id).map(v => v.itemId) ?? [] : [target.itemId]), ...frameIds]);
  const objects = located(state).filter(v => scope.ids.has(v.value.item.id));
  const groups = (state.groups ?? []).filter(v => scope.ids.has(v.itemId)), frames = (state.frames ?? []).filter(v => scope.ids.has(v.id));
  const keys = new Set([...objects.map(v => `item:${v.value.item.id}`), ...groups.map(v => `group:${v.itemId}`), ...frames.map(v => `frame:${v.id}`)]);
  const inside = (end: ConnectorEndpoint) => end.kind === 'bound' && keys.has(endpointKey(end));
  const connectors = (state.connectors ?? []).filter(line => connectorIds.includes(line.id) || inside(line.start) && inside(line.end));
  return objects.length || groups.length || frames.length || connectors.length ? { ...scope, objects, groups, frames, connectors, inside } : null;
}
function freezeEnd(state: ProjectState, end: ConnectorEndpoint, inside: (end: ConnectorEndpoint) => boolean): FrozenEnd {
  if (end.kind === 'bound' && inside(end)) return { kind: 'bound', itemId: end.itemId, side: end.side, ...(end.targetKind ? { targetKind: end.targetKind } : {}) };
  if (end.kind === 'bound') {
    const pose = endpointBounds(state, end);
    if (!pose) throw new Error('连线端点不在完整快照中，请重新读取后复制');
    return { kind: 'free', point: sidePoint(pose, end.side) };
  }
  return { kind: 'free', point: { ...end.point } };
}
export function canCopySelection(state: ProjectState | null, selection: CanvasSelection, connectorIds: string[], frameIds: string[] = []) {
  return !!state && !!picked(state, selection, connectorIds, frameIds);
}
// 单独选中一条线不能剪切：搬动必须至少包含一个画布对象或容器。
export function canCutSelection(state: ProjectState | null, selection: CanvasSelection, connectorIds: string[], frameIds: string[] = []) {
  if (!state) return false;
  const source = picked(state, selection, connectorIds, frameIds);
  return !!source && source.objects.length + source.groups.length + source.frames.length > 0;
}
export function duplicatePlan(state: ProjectState, selection: CanvasSelection, connectorIds: string[], frameIds: string[] = []): Plan | null {
  const source = picked(state, selection, connectorIds, frameIds);
  if (!source) return null;
  const objects = [...source.objects.map(v => ({ kind: v.kind, id: v.value.id, sourceItemId: v.value.item.id, copyId: crypto.randomUUID() })),
    ...source.groups.map(v => ({ kind: 'group' as const, id: v.id, sourceItemId: v.itemId, copyId: crypto.randomUUID() })),
    ...source.frames.map(v => ({ kind: 'frame' as const, id: v.id, sourceItemId: v.id, copyId: crypto.randomUUID() }))];
  const connectors = source.connectors.map(line => ({ id: line.id, copyId: crypto.randomUUID() }));
  const anchors = [...new Map(source.connectors.flatMap(line => [line.start, line.end].flatMap(end => end.kind === 'bound' && !source.inside(end) ? [[endpointKey(end), end] as const] : []))).values()];
  const containerKeys = anchors.filter(end => (end.targetKind ?? 'item') !== 'item').map(endpointKey);
  const pairVersion = (v: Exclude<Located, { kind: 'card' }>) => ({ content: v.value.versionId, pose: v.value.item.versionId });
  const of = (kind: Located['kind']) => source.objects.filter(v => v.kind === kind);
  const tree = source.groups.length || source.frames.length ? { version: 2 as const, roots: source.roots } : {};
  const command = {
    commandId: crypto.randomUUID(), projectId: state.project.id, type: 'canvas.duplicate',
    expected: {
      cards: Object.fromEntries(of('card').map(v => { const card = (v as Extract<Located, { kind: 'card' }>).value; return [card.id, { thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null }]; })),
      texts: Object.fromEntries(of('text').map(v => [v.value.id, pairVersion(v as Exclude<Located, { kind: 'card' }>)])),
      shapes: Object.fromEntries(of('shape').map(v => [v.value.id, pairVersion(v as Exclude<Located, { kind: 'card' }>)])),
      images: Object.fromEntries(of('image').map(v => [v.value.id, pairVersion(v as Exclude<Located, { kind: 'card' }>)])),
      strokes: Object.fromEntries(of('stroke').map(v => [v.value.id, pairVersion(v as Exclude<Located, { kind: 'card' }>)])),
      ...(tree.version ? { groups: Object.fromEntries(source.groups.map(v => [v.id, v.versionId])), frames: Object.fromEntries(source.frames.map(v => [v.id, v.versionId])),
        containment: Object.fromEntries([...source.ids].map(id => [id, state.containment?.find(v => v.id === id)?.versionId ?? null])) } : {}),
      connectors: Object.fromEntries(source.connectors.map(v => [v.id, v.versionId])),
      anchors: Object.fromEntries(anchors.map(end => [endpointKey(end), end.targetKind === 'group' ? state.groups!.find(v => v.itemId === end.itemId)!.versionId : end.targetKind === 'frame' ? state.frames!.find(v => v.id === end.itemId)!.versionId : located(state).find(v => v.value.item.id === end.itemId)!.value.item.versionId])),
      ...(containerKeys.length ? { endpoints: captureOptionalContainerEndpoints({ ...state, connectors: source.connectors }, containerKeys) } : {}),
    },
    payload: { ...tree, objects: objects.map(({ sourceItemId: _, ...ref }) => ref), connectors },
  } as Command;
  return { command, objectCopyIds: objects.filter(v => source.roots.includes(v.sourceItemId)).map(({ kind, copyId }) => ({ kind, copyId })), connectorCopyIds: source.connectors.flatMap((line, index) => connectorIds.includes(line.id) && !(source.inside(line.start) && source.inside(line.end)) ? [connectors[index]!.copyId] : []) };
}
function freezeObject(value: Located): FrozenObject {
  const base = { sourceId: value.value.id, itemId: value.value.item.id, stack: value.value.item.createdOrder ?? 0, pose: structuredClone(value.value.item.pose) };
  if (value.kind === 'card') return { ...base, kind: 'card', title: value.value.title, blocks: structuredClone(value.value.body.blocks), tagIds: value.value.cardTags ? [...value.value.cardTags.tagIds] : null, appearance: value.value.appearance ? { titleColor: value.value.appearance.titleColor, showPreview: value.value.appearance.showPreview } : null, ...(value.value.item.heightPolicy ? { heightPolicy: structuredClone(value.value.item.heightPolicy) } : {}) };
  return { ...base, kind: value.kind, content: structuredClone(value.value.content) } as FrozenObject;
}
export function captureClipboard(state: ProjectState, selection: CanvasSelection, connectorIds: string[], frameIds: string[] = []) {
  const source = picked(state, selection, connectorIds, frameIds);
  if (!source) return null;
  // 剪切命令需要同一份范围的显式身份：对象、整段组合与分区。
  const scope = { items: source.objects.map(value => value.value.item.id), groups: source.groups.map(value => value.id), frames: source.frames.map(value => value.id) };
  const tree = source.groups.length || source.frames.length ? { version: 2 as const, roots: source.roots,
    containment: (state.containment ?? []).flatMap(edge => edge.parent && source.ids.has(edge.id) && source.ids.has(edge.parent.id) ? [{ itemId: edge.id, parentItemId: edge.parent.id }] : []) } : { version: 1 as const };
  const document: CanvasClipboardDocument = {
    kind: 'forkwise-canvas-snapshot', ...tree,
    objects: [...source.objects.map(freezeObject),
      ...source.groups.map(v => ({ kind: 'group' as const, sourceId: v.id, itemId: v.itemId, stack: v.createdOrder, pose: structuredClone(v.bounds) })),
      ...source.frames.map(v => ({ kind: 'frame' as const, sourceId: v.id, itemId: v.id, stack: state.frames!.indexOf(v), pose: structuredClone(v.pose), name: v.name, background: v.background }))],
    connectors: source.connectors.map(line => ({ path: line.path, start: freezeEnd(state, line.start, source.inside), end: freezeEnd(state, line.end, source.inside),
      ...(line.style ? { style: structuredClone(line.style) } : {}), ...(line.label !== undefined ? { label: line.label ? structuredClone(line.label) : null } : {}) })),
  };
  return { document, text: clipboardText(document), scope };
}
export function clipboardText(document: CanvasClipboardDocument) {
  const text = document.objects.map(v => v.kind === 'card' ? v.title : v.kind === 'text' ? v.content.runs.map(run => run.text).join('') : v.kind === 'shape' ? v.content.shortText : v.kind === 'image' ? '图片' : v.kind === 'stroke' ? '笔迹' : v.kind === 'frame' ? v.name : '组合')
    .concat(document.connectors.map(line => line.label?.text ?? '连线')).filter(Boolean);
  return text.join('\n') || '画布对象';
}
export function clipboardAssetIds(document: CanvasClipboardDocument): string[] {
  return [...new Set(document.objects.flatMap(value => {
    if (value.kind === 'image') return [value.content.assetId];
    if (value.kind === 'card') return value.blocks.flatMap(block => block.type === 'image' && typeof block.assetId === 'string' ? [block.assetId] : []);
    return [];
  }))];
}
export function clipboardLibrary(state: ProjectState, document: CanvasClipboardDocument, assets: { id: string; name: string; mime: string; base64: string }[]) {
  const tagIds = [...new Set(document.objects.flatMap(value => value.kind === 'card' && value.tagIds ? value.tagIds : []))];
  const assetIds = clipboardAssetIds(document);
  if (!tagIds.length && !assetIds.length) return undefined;
  const tags = tagIds.flatMap(id => {
    const tag = state.tags?.find(value => value.id === id && !value.deleted);
    if (!tag || !(TAG_COLORS as readonly string[]).includes(tag.color)) return [];
    return [{ id: tag.id, name: tag.name, color: tag.color as typeof TAG_COLORS[number] }];
  });
  if (tags.length !== tagIds.length) throw new Error('标签不存在于当前项目');
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const stored = assetIds.flatMap(id => {
    const asset = byId.get(id);
    return asset ? [{ id: asset.id, name: asset.name, mime: asset.mime, base64: asset.base64 }] : [];
  });
  if (stored.length !== assetIds.length) throw new Error('所需媒体尚未持久保存，请完成或移除媒体后重试');
  return { tags, assets: stored };
}
export function parseClipboard(raw: string): CanvasClipboardDocument {
  try { return CanvasClipboardSchema.parse(JSON.parse(raw)); }
  catch { throw new Error("无法读取这份画布剪贴板，原内容未改变"); }
}
export function clipboardCenter(document: CanvasClipboardDocument) {
  const points = document.connectors.flatMap(line => [line.start, line.end].flatMap(end => end.kind === 'free' ? [end.point] : []));
  return boundsCenter(document.objects.map(v => v.pose), document.objects.length ? [] : points);
}
export function pastePlan(projectId: string, document: CanvasClipboardDocument, translation: Point): Plan {
  const copyIds = new Map(document.objects.map(v => [v.itemId, crypto.randomUUID()]));
  const mapEnd = (end: FrozenEnd) => end.kind === 'bound' ? { kind: 'bound' as const, copyId: copyIds.get(end.itemId)!, side: end.side, ...(end.targetKind ? { targetKind: end.targetKind } : {}) } : end;
  const objects = document.objects.map(({ sourceId: _, itemId, ...value }) => ({ ...value, copyId: copyIds.get(itemId)! }));
  const connectors = document.connectors.map(line => ({ ...line, copyId: crypto.randomUUID(), start: mapEnd(line.start), end: mapEnd(line.end) }));
  const roots = document.version === 2 ? document.roots! : document.objects.map(v => v.itemId);
  const rootCopies = new Set(roots.map(id => copyIds.get(id)!));
  const tree = document.version === 2 ? { version: 2 as const, roots: [...rootCopies], containment: document.containment!.map(edge => ({ copyId: copyIds.get(edge.itemId)!, parentCopyId: copyIds.get(edge.parentItemId)! })) } : {};
  const command = { commandId: crypto.randomUUID(), projectId, type: 'canvas.paste', expected: null, payload: { ...tree, translation, objects, connectors, ...(document.library ? { library: structuredClone(document.library) } : {}) } } as Command;
  return { command, objectCopyIds: objects.filter(v => rootCopies.has(v.copyId)).map(({ kind, copyId }) => ({ kind, copyId })),
    connectorCopyIds: document.connectors.flatMap((line, i) => line.start.kind === 'free' || line.end.kind === 'free' ? [connectors[i]!.copyId] : []) };
}
// 首次搬动沿用原身份，因此选择集合直接取剪贴板冻结快照的根。
export function restoredCopyRefs(document: CanvasClipboardDocument): CopyRef[] {
  const roots = document.version === 2 ? document.roots! : document.objects.map(value => value.itemId);
  return document.objects.filter(value => roots.includes(value.itemId)).map(value => ({ kind: value.kind, copyId: value.itemId }));
}
export function copiedSelection(state: ProjectState, entries: CopyRef[]): CanvasSelection {
  return { targets: entries.flatMap<CanvasSelection['targets'][number]>(entry => entry.kind === 'group' ? state.groups?.filter(v => v.id === entry.copyId).map(v => ({ kind: 'group' as const, id: v.id })) ?? []
    : entry.kind === 'frame' ? [] : located(state).filter(v => v.kind === entry.kind && v.value.id === entry.copyId).map(v => ({ kind: 'item' as const, itemId: v.value.item.id }))), enteredGroupId: null };
}
export function copiedItemIds(state: ProjectState, entries: CopyRef[]) {
  return copiedSelection(state, entries).targets.flatMap(v => v.kind === 'item' ? [v.itemId] : []);
}
