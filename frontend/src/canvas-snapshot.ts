import { endpointBounds, sidePoint, captureOptionalContainerEndpoints } from "../../backend/src/mapping/container-endpoints";
import { endpointKey } from "../../backend/src/mapping/connector-contracts";
export { sidePoint } from "../../backend/src/mapping/container-endpoints";
import type { ConnectorEndpoint } from "../../backend/src/mapping/connector-contracts";
import type { Command, ProjectState } from "./api";
import type { CanvasSelection } from "./canvas-selection";
import { boundsCenter, type Box, type Point } from "./canvas-snapshot-geometry";

export const CANVAS_CLIPBOARD_TYPE = "web application/x-forkwise-canvas";
type Side = "top" | "right" | "bottom" | "left";
type Kind = "card" | "text" | "shape" | "image" | "stroke";
type Located =
  | { kind: "card"; value: ProjectState["cards"][number] }
  | { kind: "text"; value: NonNullable<ProjectState["texts"]>[number] }
  | { kind: "shape"; value: NonNullable<ProjectState["shapes"]>[number] }
  | { kind: "image"; value: NonNullable<ProjectState["images"]>[number] }
  | { kind: "stroke"; value: NonNullable<ProjectState["strokes"]>[number] };
type FrozenEnd = { kind: "free"; point: Point } | { kind: "bound"; itemId: string; side: Side };
type FrozenObject = {
  kind: Kind;
  sourceId: string;
  itemId: string;
  stack: number;
  pose: Box | NonNullable<ProjectState["images"]>[number]["item"]["pose"];
  title?: string;
  blocks?: ProjectState["cards"][number]["body"]["blocks"];
  tagIds?: string[] | null;
  appearance?: { titleColor: NonNullable<ProjectState["cards"][number]["appearance"]>["titleColor"]; showPreview: boolean } | null;
  heightPolicy?: ProjectState["cards"][number]["item"]["heightPolicy"];
  content?: unknown;
};
export type CanvasClipboardDocument = {
  kind: "forkwise-canvas-snapshot";
  version: 1;
  objects: FrozenObject[];
  connectors: { path: "straight" | "elbow" | "curve"; style?: NonNullable<NonNullable<ProjectState["connectors"]>[number]["style"]>; label?: NonNullable<ProjectState["connectors"]>[number]["label"]; start: FrozenEnd; end: FrozenEnd }[];
};
type Plan = { command: Command; objectCopyIds: { kind: Kind; copyId: string }[]; connectorCopyIds: string[] };

function located(state: ProjectState, itemId: string): Located | null {
  const card = state.cards.find(value => value.item.id === itemId);
  if (card) return { kind: "card", value: card };
  const text = state.texts?.find(value => value.item.id === itemId);
  if (text) return { kind: "text", value: text };
  const shape = state.shapes?.find(value => value.item.id === itemId);
  if (shape) return { kind: "shape", value: shape };
  const image = state.images?.find(value => value.item.id === itemId);
  if (image) return { kind: "image", value: image };
  const stroke = state.strokes?.find(value => value.item.id === itemId);
  if (stroke) return { kind: "stroke", value: stroke };
  return null;
}
function picked(state: ProjectState, selection: CanvasSelection, connectorIds: string[]) {
  if (selection.targets.some(target => target.kind === "group")) return null;
  const objects = selection.targets.flatMap(target => target.kind === "item" ? [located(state, target.itemId)] : []).filter((value): value is Located => !!value);
  const itemIds = new Set(objects.map(value => value.value.item.id));
  const chosen = new Set(connectorIds);
  const connectors = (state.connectors ?? []).filter(line => {
    const inside = (end: ConnectorEndpoint) => end.kind === "bound" && (end.targetKind ?? "item") === "item" && itemIds.has(end.itemId);
    return chosen.has(line.id) || (inside(line.start) && inside(line.end));
  });
  return objects.length || connectors.length ? { objects, connectors, itemIds } : null;
}
function freezeEnd(state: ProjectState, end: ConnectorEndpoint, itemIds: Set<string>): FrozenEnd {
  if (end.kind === "bound" && (end.targetKind ?? "item") === "item" && itemIds.has(end.itemId)) return { kind: "bound", itemId: end.itemId, side: end.side };
  if (end.kind === "bound") {
    const pose = endpointBounds(state, end);
    if (!pose) throw new Error("连线端点不在完整快照中，请重新读取后复制");
    return { kind: "free", point: sidePoint(pose, end.side) };
  }
  return { kind: "free", point: { ...end.point } };
}
export function canCopySelection(state: ProjectState | null, selection: CanvasSelection, connectorIds: string[]) {
  return !!state && !!picked(state, selection, connectorIds);
}
export function duplicatePlan(state: ProjectState, selection: CanvasSelection, connectorIds: string[]): Plan | null {
  const source = picked(state, selection, connectorIds);
  if (!source) return null;
  const objects = source.objects.map(value => ({ kind: value.kind, id: value.value.id, copyId: crypto.randomUUID() }));
  const connectors = source.connectors.map(line => ({ id: line.id, copyId: crypto.randomUUID() }));
  const anchors = [...new Map(source.connectors.flatMap(line => [line.start, line.end].flatMap(end => end.kind === "bound" && !((end.targetKind ?? "item") === "item" && source.itemIds.has(end.itemId)) ? [[endpointKey(end), end] as const] : []))).values()];
  const containerKeys = anchors.filter(end => (end.targetKind ?? "item") !== "item").map(endpointKey);
  const cardVersion = (value: Extract<Located, { kind: "card" }>) => ({ thought: value.value.versionId, body: value.value.body.versionId, pose: value.value.item.versionId, appearance: value.value.appearance?.versionId ?? null, cardTags: value.value.cardTags?.versionId ?? null });
  const pairVersion = (value: Exclude<Located, { kind: "card" }>) => ({ content: value.value.versionId, pose: value.value.item.versionId });
  const of = (kind: Kind) => source.objects.filter(value => value.kind === kind);
  const command = {
    commandId: crypto.randomUUID(), projectId: state.project.id, type: "canvas.duplicate",
    expected: {
      cards: Object.fromEntries(of("card").map(value => [value.value.id, cardVersion(value as Extract<Located, { kind: "card" }> )])),
      texts: Object.fromEntries(of("text").map(value => [value.value.id, pairVersion(value as Exclude<Located, { kind: "card" }> )])),
      shapes: Object.fromEntries(of("shape").map(value => [value.value.id, pairVersion(value as Exclude<Located, { kind: "card" }> )])),
      images: Object.fromEntries(of("image").map(value => [value.value.id, pairVersion(value as Exclude<Located, { kind: "card" }> )])),
      strokes: Object.fromEntries(of("stroke").map(value => [value.value.id, pairVersion(value as Exclude<Located, { kind: "card" }> )])),
      connectors: Object.fromEntries(connectors.map(line => [line.id, source.connectors.find(value => value.id === line.id)!.versionId])),
      anchors: Object.fromEntries(anchors.map(end => [endpointKey(end), end.targetKind === "group" ? state.groups!.find(group => group.itemId === end.itemId)!.versionId : end.targetKind === "frame" ? state.frames!.find(frame => frame.id === end.itemId)!.versionId : located(state, end.itemId)!.value.item.versionId])),
      ...(containerKeys.length ? { endpoints: captureOptionalContainerEndpoints({ ...state, connectors: source.connectors }, containerKeys) } : {}),
    },
    payload: { objects, connectors },
  } as Command;
  return { command, objectCopyIds: objects.map(value => ({ kind: value.kind, copyId: value.copyId })), connectorCopyIds: connectors.map(value => value.copyId) };
}
function freezeObject(value: Located): FrozenObject {
  const base = { kind: value.kind, sourceId: value.value.id, itemId: value.value.item.id, stack: value.value.item.createdOrder ?? 0, pose: structuredClone(value.value.item.pose) };
  if (value.kind === "card") return { ...base, title: value.value.title, blocks: structuredClone(value.value.body.blocks), tagIds: value.value.cardTags ? [...value.value.cardTags.tagIds] : null, appearance: value.value.appearance ? { titleColor: value.value.appearance.titleColor, showPreview: value.value.appearance.showPreview } : null, ...(value.value.item.heightPolicy ? { heightPolicy: structuredClone(value.value.item.heightPolicy) } : {}) };
  return { ...base, content: structuredClone(value.value.content) };
}
export function captureClipboard(state: ProjectState, selection: CanvasSelection, connectorIds: string[]) {
  const source = picked(state, selection, connectorIds);
  if (!source) return null;
  const document: CanvasClipboardDocument = {
    kind: "forkwise-canvas-snapshot", version: 1,
    objects: source.objects.map(freezeObject),
    connectors: source.connectors.map(line => ({
      path: line.path, start: freezeEnd(state, line.start, source.itemIds), end: freezeEnd(state, line.end, source.itemIds),
      ...(line.style ? { style: structuredClone(line.style) } : {}),
      ...(line.label !== undefined ? { label: line.label ? structuredClone(line.label) : null } : {}),
    })),
  };
  return { document, text: clipboardText(document) };
}
export function clipboardText(document: CanvasClipboardDocument) {
  const text = document.objects.map(value => value.kind === "card" ? value.title : value.kind === "text" ? textOf(value.content) : value.kind === "shape" ? shapeText(value.content) : value.kind === "image" ? "图片" : "笔迹").concat(document.connectors.map(line => line.label && typeof line.label === "object" ? line.label.text : "连线")).filter(Boolean);
  return text.join("\n") || "画布对象";
}
function textOf(content: unknown) {
  const runs = content && typeof content === "object" && "runs" in content ? content.runs : [];
  return Array.isArray(runs) ? runs.map(run => run && typeof run === "object" && "text" in run ? String(run.text) : "").join("") : "";
}
function shapeText(content: unknown) {
  return content && typeof content === "object" && "shortText" in content ? String(content.shortText) : "形状";
}
export function parseClipboard(raw: string): CanvasClipboardDocument {
  const value = JSON.parse(raw) as CanvasClipboardDocument;
  if (value?.kind !== "forkwise-canvas-snapshot" || value.version !== 1 || !Array.isArray(value.objects) || !Array.isArray(value.connectors))
    throw new Error("无法读取这份画布剪贴板，原内容未改变");
  return value;
}
export function clipboardCenter(document: CanvasClipboardDocument) {
  const points = document.connectors.flatMap(line => [line.start, line.end].flatMap(end => end.kind === "free" ? [end.point] : []));
  return boundsCenter(document.objects.map(value => value.pose), document.objects.length ? [] : points);
}
export function pastePlan(projectId: string, document: CanvasClipboardDocument, translation: Point): Plan {
  const copyIds = new Map(document.objects.map(value => [value.itemId, crypto.randomUUID()]));
  const mapEnd = (end: FrozenEnd) => end.kind === "bound"
    ? { kind: "bound" as const, copyId: copyIds.get(end.itemId)!, side: end.side }
    : { kind: "free" as const, point: end.point };
  const objects = document.objects.map(value => {
    const copyId = copyIds.get(value.itemId)!;
    if (value.kind === "card") return { kind: "card" as const, copyId, stack: value.stack, title: value.title ?? "", blocks: value.blocks ?? [{ id: "blank", type: "text", text: "" }], tagIds: value.tagIds ?? null, appearance: value.appearance ?? null, pose: value.pose, ...(value.heightPolicy ? { heightPolicy: value.heightPolicy } : {}) };
    if (value.kind === "text") return { kind: "text" as const, copyId, stack: value.stack, content: value.content, pose: value.pose };
    if (value.kind === "shape") return { kind: "shape" as const, copyId, stack: value.stack, content: value.content, pose: value.pose };
    if (value.kind === "image") return { kind: "image" as const, copyId, stack: value.stack, content: value.content, pose: value.pose };
    return { kind: "stroke" as const, copyId, stack: value.stack, content: value.content, pose: value.pose };
  });
  const connectors = document.connectors.map(line => ({
    copyId: crypto.randomUUID(), path: line.path, start: mapEnd(line.start), end: mapEnd(line.end),
    ...(line.style ? { style: line.style } : {}),
    ...(line.label !== undefined ? { label: line.label } : {}),
  }));
  const command = { commandId: crypto.randomUUID(), projectId, type: "canvas.paste", expected: null, payload: { translation, objects, connectors } } as Command;
  return { command, objectCopyIds: objects.map(value => ({ kind: value.kind, copyId: value.copyId })), connectorCopyIds: connectors.map(value => value.copyId) };
}
export function copiedItemIds(state: ProjectState, entries: { kind: Kind; copyId: string }[]) {
  return entries.flatMap(entry => {
    const list = entry.kind === "card" ? state.cards : entry.kind === "text" ? state.texts : entry.kind === "shape" ? state.shapes : entry.kind === "image" ? state.images : state.strokes;
    const found = list?.find(value => value.id === entry.copyId);
    return found ? [found.item.id] : [];
  });
}
