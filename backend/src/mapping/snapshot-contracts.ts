import { FramePlacement } from './frame-spatial.js';
import { ContainerEndpointExpected } from './container-endpoints.js';
import { z } from 'zod';
import { ConnectorLabelSchema, ConnectorPathSchema, ConnectorStyleSchema } from './connector-contracts.js';
import { ImageContentSchema, ImagePoseSchema } from './image-contracts.js';
import { TITLE_COLORS } from './presentation-values.js';
import { ShapeContentSchema, ShapePoseSchema } from './shape-contracts.js';
import { StrokeContentSchema, StrokePoseSchema } from './stroke-contracts.js';
import { TextContentSchema, TextPoseSchema } from './text-contracts.js';

const Id = z.string().min(1).max(160);
const Envelope = { commandId: Id, projectId: Id, placement: FramePlacement.optional() };
const Side = z.enum(['top', 'right', 'bottom', 'left']);
const Point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const CardVersions = z.object({
  thought: Id, body: Id, pose: Id, appearance: Id.nullable(), cardTags: Id.nullable(),
}).strict();
const Pair = z.object({ content: Id, pose: Id }).strict();
const CopyRef = z.object({
  kind: z.enum(['card', 'text', 'shape', 'image', 'stroke', 'group', 'frame']),
  id: Id,
  copyId: Id,
}).strict();
const Block = z.object({ id: Id, type: z.string().min(1).max(80) }).passthrough();
const Appearance = z.object({
  titleColor: z.enum(TITLE_COLORS),
  showPreview: z.boolean(),
}).strict();
const HeightPolicy = z.object({
  manualHeight: z.number().finite().nullable(),
  necessaryHeight: z.number().finite(),
  previewFloor: z.number().finite().optional(),
}).strict();
const PasteEnd = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('free'), point: Point }).strict(),
  z.object({ kind: z.literal('bound'), copyId: Id, side: Side, targetKind: z.enum(['item', 'group', 'frame']).optional() }).strict(),
]);
export const PasteObject = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('card'), copyId: Id, stack: z.number().finite(),
    title: z.string().max(10000),
    blocks: z.array(Block).min(1).max(5000),
    tagIds: z.array(Id).max(100).nullable(),
    appearance: Appearance.nullable(),
    pose: TextPoseSchema,
    heightPolicy: HeightPolicy.optional(),
  }).strict(),
  z.object({
    kind: z.literal('text'), copyId: Id, stack: z.number().finite(),
    content: TextContentSchema, pose: TextPoseSchema,
  }).strict(),
  z.object({
    kind: z.literal('shape'), copyId: Id, stack: z.number().finite(),
    content: ShapeContentSchema, pose: ShapePoseSchema,
  }).strict(),
  z.object({
    kind: z.literal('image'), copyId: Id, stack: z.number().finite(),
    content: ImageContentSchema, pose: ImagePoseSchema,
  }).strict(),
  z.object({
    kind: z.literal('stroke'), copyId: Id, stack: z.number().finite(),
    content: StrokeContentSchema, pose: StrokePoseSchema,
  }).strict(),
  z.object({ kind: z.literal('group'), copyId: Id, stack: z.number().finite(), pose: TextPoseSchema }).strict(),
  z.object({ kind: z.literal('frame'), copyId: Id, stack: z.number().finite(), name: z.string().trim().min(1).max(240), background: z.string().nullable(), pose: TextPoseSchema }).strict(),
]);
const Tree = { version: z.literal(2).optional(), roots: z.array(Id).max(200).optional(), containment: z.array(z.object({ copyId: Id, parentCopyId: Id }).strict()).max(200).optional() };
const PasteConnector = z.object({
  copyId: Id,
  path: ConnectorPathSchema,
  style: ConnectorStyleSchema.optional(),
  label: ConnectorLabelSchema.nullable().optional(),
  start: PasteEnd,
  end: PasteEnd,
}).strict();

export const CanvasDuplicateCommand = z.object({
  ...Envelope,
  type: z.literal('canvas.duplicate'),
  expected: z.object({
    cards: z.record(Id, CardVersions),
    texts: z.record(Id, Pair),
    shapes: z.record(Id, Pair),
    images: z.record(Id, Pair),
    strokes: z.record(Id, Pair),
    connectors: z.record(Id, Id),
    anchors: z.record(z.string().min(1).max(166), Id),
    endpoints: ContainerEndpointExpected.optional(),
    groups: z.record(Id, Id).optional(), frames: z.record(Id, Id).optional(), containment: z.record(Id, Id.nullable()).optional(),
  }).strict(),
  payload: z.object({
    version: z.literal(2).optional(), roots: z.array(Id).min(1).max(200).optional(),
    objects: z.array(CopyRef).max(200),
    connectors: z.array(z.object({ id: Id, copyId: Id }).strict()).max(400),
  }).strict().refine(value => value.objects.length + value.connectors.length > 0, '至少选择一个复制对象').refine(value => value.version === 2 ? !!value.roots : !value.roots && !value.objects.some(v => v.kind === 'group' || v.kind === 'frame'), '容器复制须显式使用 v2 与根列表'),
}).strict();


type TreeInput = { version?: number | undefined; roots?: string[] | undefined; containment?: { copyId: string; parentCopyId: string }[] | undefined;
  objects: { copyId: string; kind: string }[]; connectors: { copyId?: string; start: z.infer<typeof PasteEnd>; end: z.infer<typeof PasteEnd> }[] };
function validateSnapshotTree(value: TreeInput, ctx: z.RefinementCtx) {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const objects = new Map(value.objects.map(v => [v.copyId, v]));
  const connectorIds = value.connectors.flatMap(v => v.copyId === undefined ? [] : [v.copyId]);
  if (objects.size !== value.objects.length || new Set([...objects.keys(), ...connectorIds]).size !== value.objects.length + connectorIds.length) fail('快照身份重复');
  for (const line of value.connectors) for (const end of [line.start, line.end]) if (end.kind === 'bound') {
    const node = objects.get(end.copyId);
    if (!node || node.kind === 'stroke' || (end.targetKind ?? 'item') !== (node.kind === 'group' || node.kind === 'frame' ? node.kind : 'item')) fail('快照连线端点类型或身份无效');
  }
  if (value.version !== 2) {
    if (value.roots || value.containment || value.objects.some(v => v.kind === 'group' || v.kind === 'frame')) fail('容器快照须显式使用 v2');
    return;
  }
  if (!value.roots || !value.containment) { fail('v2 须包含完整根与归属树'); return; }
  for (const object of value.objects) if (object.kind === 'group' && !value.containment.some(edge => edge.parentCopyId === object.copyId)) fail('组合至少包含一个普通成员');
  const roots = new Set(value.roots), parents = new Map<string, string>();
  if (roots.size !== value.roots.length || value.roots.some(id => !objects.has(id))) fail('快照根不存在或重复');
  for (const edge of value.containment) {
    const node = objects.get(edge.copyId), parent = objects.get(edge.parentCopyId);
    if (!node || !parent || !['group', 'frame'].includes(parent.kind) || parent.kind === 'group' && ['group', 'frame'].includes(node.kind) || parents.has(edge.copyId) || roots.has(edge.copyId)) fail('快照归属不闭合或非单父');
    parents.set(edge.copyId, edge.parentCopyId);
  }
  for (const id of objects.keys()) {
    const seen = new Set<string>(); let current = id;
    while (parents.has(current) && !seen.has(current)) { seen.add(current); current = parents.get(current)!; }
    if (seen.has(current) || !roots.has(current)) fail('快照有环或缺少根');
  }
}

export const CanvasPasteCommand = z.object({
  ...Envelope,
  type: z.literal('canvas.paste'),
  expected: z.null(),
  payload: z.object({
    ...Tree,
    translation: Point,
    objects: z.array(PasteObject).max(200),
    connectors: z.array(PasteConnector).max(400),
  }).strict().refine(value => value.objects.length + value.connectors.length > 0, '剪贴板没有可粘贴的画布对象').superRefine(validateSnapshotTree),
}).strict();

export const SnapshotCommands = [CanvasDuplicateCommand, CanvasPasteCommand] as const;

// Clipboard is a frozen document, with source identity used only for remapping inside it.
const Identity = { sourceId: Id, itemId: Id };
const FrozenObject = z.discriminatedUnion('kind', [
  PasteObject.options[0].omit({ copyId: true }).extend(Identity),
  PasteObject.options[1].omit({ copyId: true }).extend(Identity),
  PasteObject.options[2].omit({ copyId: true }).extend(Identity),
  PasteObject.options[3].omit({ copyId: true }).extend(Identity),
  PasteObject.options[4].omit({ copyId: true }).extend(Identity),
  PasteObject.options[5].omit({ copyId: true }).extend(Identity),
  PasteObject.options[6].omit({ copyId: true }).extend(Identity),
]);
const FrozenEnd = z.discriminatedUnion('kind', [
  PasteEnd.options[0],
  PasteEnd.options[1].omit({ copyId: true }).extend({ itemId: Id }),
]);
export const CanvasClipboardSchema = z.object({
  kind: z.literal('forkwise-canvas-snapshot'), version: z.union([z.literal(1), z.literal(2)]),
  roots: z.array(Id).max(200).optional(),
  containment: z.array(z.object({ itemId: Id, parentItemId: Id }).strict()).max(200).optional(),
  objects: z.array(FrozenObject).max(200),
  connectors: z.array(PasteConnector.omit({ copyId: true, start: true, end: true }).extend({ start: FrozenEnd, end: FrozenEnd })).max(400),
}).strict().refine(v => v.objects.length + v.connectors.length > 0, '剪贴板没有可粘贴的画布对象').superRefine((value, ctx) => {
  const mapEnd = (end: z.infer<typeof FrozenEnd>): z.infer<typeof PasteEnd> => end.kind === 'bound'
    ? { kind: 'bound', copyId: end.itemId, side: end.side, ...(end.targetKind ? { targetKind: end.targetKind } : {}) } : end;
  validateSnapshotTree({ version: value.version === 2 ? 2 : undefined, roots: value.roots,
    containment: value.containment?.map(edge => ({ copyId: edge.itemId, parentCopyId: edge.parentItemId })),
    objects: value.objects.map(v => ({ ...v, copyId: v.itemId })),
    connectors: value.connectors.map(v => ({ ...v, start: mapEnd(v.start), end: mapEnd(v.end) })),
  }, ctx);
});
