import { FramePlacement } from './frame-spatial.js';
import { AttachmentCommands, FollowerFields, type Attachment, type AttachmentChange } from './attachment-contracts.js';
import { FrameCommands, type CanvasFrame, type FrameChange } from './frame-contracts.js';
import { MembershipExpected } from './containment-contracts.js';
import { GroupGeometryCommands } from './group-geometry-contracts.js';
import { GroupCommands, type CanvasGroup, type Containment, type GroupChange, type ContainmentChange } from './group-contracts.js';
import { LayerOrderCommand } from './layer-contracts.js';
import { CanvasDuplicateCommand, CanvasPasteCommand } from './snapshot-contracts.js';
import { CutCommands } from './cut-contracts.js';
import { ConnectorCommands, type CanvasConnector, type ConnectorChange, type EndpointKind } from './connector-contracts.js';
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
const Envelope = { commandId: Id, projectId: Id, placement: FramePlacement.optional() };
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
  ...AttachmentCommands.options,
  ...FrameCommands.options,
  ...GroupGeometryCommands.options,
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
  LayerOrderCommand,
  CanvasDuplicateCommand,
  CanvasPasteCommand,
  ...CutCommands,
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
      ...FollowerFields,
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
  z.object({ ...Envelope, ...FollowerFields, type: z.literal('canvas.move'), expected: z.record(Id, Id), payload: z.object({ targets: z.array(z.object({ kind: z.enum(['card', 'text', 'shape', 'image', 'stroke']), id: Id, itemId: Id, x: z.number().finite(), y: z.number().finite() }).strict()).min(1) }).strict() }).strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('pose.batch'),
      ...FollowerFields,
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
  frames?: CanvasFrame[];
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
  attachments?: Attachment[];
}
export interface Receipt {
  // 剪切资格随回执返回，前端据此确认首次搬动是否被服务端接受。
  cut?: import('./cut-contracts.js').CutStateView;
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
export type TagChange = { before: Tag | null; after: Tag };
export interface MediaAsset {
  id: string;
  name: string;
  mime: string;
  base64: string;
  width: number;
  height: number;
  hash: string;
}
export type AssetChange = { before: { id: string } | null; after: MediaAsset };
// 剪切结束时仍存在的外线外端及其内容指纹；首次搬动前逐项比对，判定期间是否被改动。
export interface CutOuterEnd {
  kind: EndpointKind;
  itemId: string;
  fingerprint: string;
}
export interface Change extends Receipt {
  frameChanges?: FrameChange[];
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
  tagChange?: TagChange;
  tagChanges?: TagChange[];
  assetChanges?: AssetChange[];
  cardChanges?: { before: Card; after: Card }[];
  attachmentChanges?: AttachmentChange[];
  // 84af656c 及更早的剪切回执没有该字段（旧字段 cutOuterVersions 只有 id→version，缺 kind 与
  // 组合成员 pose，无法重建指纹）；粘贴时按状态不可判定拒绝（CUT_OUTER_UNKNOWN），不猜测性迁移。
  cutOuterEnds?: CutOuterEnd[];
  before: Project | Card | null;
  after: Project | Card | null;
  actor: { id: string; type: 'human' | 'agent' | 'system' };
  writtenAt: string;
}
export type { HistoryAction, ProjectHistory } from './history-contracts.js';
