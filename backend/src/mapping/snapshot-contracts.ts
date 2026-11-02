import { ContainerEndpointExpected } from './container-endpoints.js';
import { z } from 'zod';
import { ConnectorLabelSchema, ConnectorPathSchema, ConnectorStyleSchema } from './connector-contracts.js';
import { ImageContentSchema, ImagePoseSchema } from './image-contracts.js';
import { TITLE_COLORS } from './presentation-values.js';
import { ShapeContentSchema, ShapePoseSchema } from './shape-contracts.js';
import { StrokeContentSchema, StrokePoseSchema } from './stroke-contracts.js';
import { TextContentSchema, TextPoseSchema } from './text-contracts.js';

const Id = z.string().min(1).max(160);
const Envelope = { commandId: Id, projectId: Id };
const Side = z.enum(['top', 'right', 'bottom', 'left']);
const Point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const CardVersions = z.object({
  thought: Id, body: Id, pose: Id, appearance: Id.nullable(), cardTags: Id.nullable(),
}).strict();
const Pair = z.object({ content: Id, pose: Id }).strict();
const CopyRef = z.object({
  kind: z.enum(['card', 'text', 'shape', 'image', 'stroke']),
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
  z.object({ kind: z.literal('bound'), copyId: Id, side: Side }).strict(),
]);
const PasteObject = z.discriminatedUnion('kind', [
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
]);
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
  }).strict(),
  payload: z.object({
    objects: z.array(CopyRef).max(200),
    connectors: z.array(z.object({ id: Id, copyId: Id }).strict()).max(400),
  }).strict().refine(value => value.objects.length + value.connectors.length > 0, '至少选择一个复制对象'),
}).strict();

export const CanvasPasteCommand = z.object({
  ...Envelope,
  type: z.literal('canvas.paste'),
  expected: z.null(),
  payload: z.object({
    translation: Point,
    objects: z.array(PasteObject).max(200),
    connectors: z.array(PasteConnector).max(400),
  }).strict().refine(value => value.objects.length + value.connectors.length > 0, '剪贴板没有可粘贴的画布对象'),
}).strict();

export const SnapshotCommands = [CanvasDuplicateCommand, CanvasPasteCommand] as const;
