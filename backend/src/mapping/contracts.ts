import { MembershipExpected } from './containment-contracts.js';
import { GroupCommands, type CanvasGroup, type Containment, type GroupChange, type ContainmentChange } from './group-contracts.js';
import { ConnectorCommands, type CanvasConnector, type ConnectorChange } from './connector-contracts.js';
import { ImageCommands, type CanvasImage, type ImageChange } from './image-contracts.js';
import { TagCommandSchema } from './tag-contracts.js';
import { TextCommands, type CanvasText, type TextChange } from './text-contracts.js';
import { StrokeCreateCommand, StrokeDeleteCommand, type CanvasStroke, type StrokeChange } from './stroke-contracts.js';
import { ShapeCreateCommand, ShapeEditCommand, ShapeMoveCommand, ShapeDeleteCommand, ShapeTransformCommand, type CanvasShape, type ShapeChange } from './shape-contracts.js';
import { z } from 'zod';
import { TITLE_COLORS } from './presentation-values.js';
import { bodyText } from './body-text.js';
import { SearchConditionsSchema, type SearchStateView } from './search-contracts.js';
const Id = z.string().min(1).max(160);
const Name = z.string().trim().min(1).max(240);
const Envelope = { commandId: Id, projectId: Id };
export const BodyBlock = z
  .object({ id: Id, type: z.string().min(1), text: z.string().optional(), inlineId: Id.optional() })
  .passthrough();
export type Block = z.infer<typeof BodyBlock>;
const BodyInput = {
  text: z.string().max(200000).optional(),
  blocks: z
    .array(BodyBlock)
    .min(1)
    .refine((blocks) => bodyText({ blocks }).length <= 200000, '正文文字不能超过200000')
    .optional(),
};
export { TagCommandSchema } from './tag-contracts.js';
export const MappingCommand = z.discriminatedUnion('type', [
  ...GroupCommands.options,
  ...ConnectorCommands.options,
  ...ImageCommands.options,
  StrokeCreateCommand,
  StrokeDeleteCommand,
  ShapeCreateCommand,
  ShapeEditCommand,
  ShapeMoveCommand,
  ShapeDeleteCommand,
  ShapeTransformCommand,
  ...TextCommands.options,
  z.object({ ...Envelope, type: z.literal('search.delete'), expected: Id.nullable(), payload: z.object({ query: SearchConditionsSchema, id: Id }).strict() }).strict(),
  z.object({ ...Envelope, type: z.literal('search.clear'), expected: Id.nullable(), payload: z.object({ query: SearchConditionsSchema }).strict() }).strict(),
  z.object({ ...Envelope, type: z.literal('search.restore'), expected: Id.nullable(), payload: z.object({ undoId: Id }).strict() }).strict(),
  z.object({ ...Envelope, type: z.literal('search.record'), expected: Id.nullable(), payload: z.object({ query: SearchConditionsSchema, intent: z.enum(['exit', 'open']), pending: z.array(z.record(z.string(), z.unknown())).max(200).optional() }).strict() }).strict(),
  z.object({ ...Envelope, type: z.literal('search.save'), expected: Id.nullable(), payload: z.object({ query: SearchConditionsSchema }).strict() }).strict(),
  ...TagCommandSchema.options,
  z.object({...Envelope,type:z.literal('media.retry'),expected:Id,payload:z.object({id:Id,blockId:Id,ticket:Id}).strict()}).strict(),
  z.object({...Envelope,type:z.literal('media.finish'),expected:Id,payload:z.object({id:Id,blockId:Id,assetId:Id}).strict()}).strict(),
  z.object({...Envelope,type:z.literal('media.fail'),expected:Id,payload:z.object({id:Id,blockId:Id,reason:z.string().min(1).max(2000)}).strict()}).strict(),
  z.object({...Envelope,type:z.literal('asset.save'),expected:z.null(),payload:z.object({id:Id,name:z.string().min(1).max(4096),mime:z.string().max(100),base64:z.string().max(699052)}).strict()}).strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('thought.delete'),
      expected: z.object({ thought: Id, body: Id, pose: Id, appearance: Id.nullable(), cardTags: Id.nullable().optional(), connectors: z.record(Id, Id).optional(), membership: MembershipExpected.optional() }).strict(),
      payload: z.object({ id: Id }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('card.layout'),
      expected: z.object({ thought: Id, body: Id, pose: Id, appearance: Id.nullable(), cardTags: Id.nullable().optional() }).strict(),
      payload: z.object({ id: Id, necessaryHeight: z.number().finite().positive() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('card.appearance'),
      expected: Id.nullable(),
      payload: z
        .object({ id: Id, titleColor: z.enum(TITLE_COLORS), showPreview: z.boolean() })
        .strict(),
    })
    .strict(),
  z.object({ ...Envelope, type: z.literal('canvas.move'), expected: z.record(Id, Id), payload: z.object({ targets: z.array(z.object({ kind: z.enum(['card', 'text', 'shape', 'image', 'stroke']), id: Id, itemId: Id, x: z.number().finite(), y: z.number().finite() }).strict()).min(1) }).strict() }).strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('pose.batch'),
      expected: z.record(Id, Id),
      payload: z
        .object({
          poses: z
            .array(
              z
                .object({
                  id: Id,
                  x: z.number().finite(),
                  y: z.number().finite(),
                  width: z.number().finite().positive(),
                  height: z.number().finite().positive(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('history.undo'),
      expected: z.number().int().nonnegative(),
      payload: z.object({ actionId: Id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('history.redo'),
      expected: z.number().int().nonnegative(),
      payload: z.object({ actionId: Id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('card.edit'),
      expected: z.object({ body: Id, pose: Id }).strict(),
      payload: z
        .object({
          id: Id,
          ...BodyInput,
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .strict()
        .refine(
          (p) => (p.text === undefined) !== (p.blocks === undefined),
          '正文须提供text或blocks之一',
        ),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('pose.move'),
      expected: Id,
      payload: z.object({ id: Id, x: z.number().finite(), y: z.number().finite() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('project.rename'),
      expected: Id,
      payload: z.object({ name: Name }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('thought.title'),
      editGroup: Id.optional(),
      expected: Id,
      payload: z.object({ id: Id, title: z.string().max(10000) }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('body.edit'),
      editGroup: Id.optional(),
      expected: Id,
      payload: z
        .object({
          id: Id,
          ...BodyInput,
          copyOriginals: z.literal(true).optional(),
          requiredAssetIds: z.array(Id).max(128).optional(),
        })
        .strict()
        .refine(
          (p) => (p.text === undefined) !== (p.blocks === undefined),
          '正文须提供text或blocks之一',
        ),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('project.create'),
      expected: z.null(),
      payload: z.object({ name: Name }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('thought.create'),
      editGroup: Id.optional(),
      expected: z.null(),
      payload: z
        .object({
          id: Id,
          title: z.string().max(10000),
          text: z.string().max(200000),
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .strict(),
    })
    .strict(),
]);
export type Command = z.infer<typeof MappingCommand>;
export interface Project {
  id: string;
  name: string;
  versionId: string;
  revision: number;
}
export interface Card {
  cardTags?: { id: string; versionId: string; tagIds: string[] };
  id: string;
  title: string;
  versionId: string;
  appearance?: {
    id: string;
    versionId: string;
    titleColor: Extract<Command, { type: 'card.appearance' }>['payload']['titleColor'];
    showPreview: boolean;
  };
  body: { id: string; versionId: string; blocks: Block[] };
  item: {
    createdOrder?: number;
    id: string;
    versionId: string;
    pose: { x: number; y: number; width: number; height: number };
    heightPolicy?: { manualHeight: number | null; necessaryHeight: number; previewFloor?: number };
  };
}
export interface Tag { id: string; versionId: string; name: string; color: string; deleted: boolean }
export interface ProjectState {
  groups?: CanvasGroup[];
  containment?: Containment[];
  connectors?: CanvasConnector[];
  images?: CanvasImage[];
  project: Project;
  cards: Card[];
  tags?: Tag[];
  texts?: CanvasText[];
  shapes?: CanvasShape[];
  strokes?: CanvasStroke[];
}
export interface Receipt {
  itemPoseVersions?: Record<string, string>;
  cardPoseVersions?: Record<string, string>;
  connectorVersions?: Record<string, string>;
  imageVersions?: { image: string; pose: string };
  strokeVersions?: { stroke: string; pose: string };
  shapeVersions?: { shape: string; pose: string };
  textVersions?: { text: string; pose: string };
  commandId: string;
  projectId: string;
  revision: number;
  searchState?: SearchStateView;
  changedIds: string[];
  deletedIds?: string[];
  historyTarget?: { id: string; title: string; label: string };
  versions?: { thought: string; body: string; pose: string; appearance?: string };
}
export type { VersionQuery, CardIdentity, IdentityQuery, AssetQuery, ReadQuery } from './read-contracts.js';
export interface Change extends Receipt {
  cardLifecycleChanges?: { before: Card | null; after: Card | null }[];
  groupChanges?: GroupChange[];
  containmentChanges?: ContainmentChange[];
  connectorChanges?: ConnectorChange[];
  imageChanges?: ImageChange[];
  imageChange?: ImageChange;
  strokeChange?: StrokeChange;
  strokeChanges?: StrokeChange[];
  shapeChange?: ShapeChange;
  shapeChanges?: ShapeChange[];
  textChanges?: TextChange[];
  textChange?: TextChange;
  tagChange?: { before: Tag | null; after: Tag };
  cardChanges?: { before: Card; after: Card }[];
  before: Project | Card | null;
  after: Project | Card | null;
  actor: { id: string; type: 'human' | 'agent' | 'system' };
  writtenAt: string;
}
export type { HistoryAction, ProjectHistory } from './history-contracts.js';
