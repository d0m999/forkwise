import { ContainerEndpointExpected } from './container-endpoints.js';
import { DeleteMember } from './group-contracts.js';
import { FramePlacement } from './frame-spatial.js';
import { z } from 'zod';

const Id = z.string().min(1).max(160);
const Point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const CUT_STATES = ['eligible', 'consumed', 'cut-undone'] as const;
export type CutState = (typeof CUT_STATES)[number];

// 剪切范围由前端展开成完整子树；后端按同一套删除事实校验，再在同一事务里写剪切记录。
export const CanvasCutCommand = z.object({
  commandId: Id,
  projectId: Id,
  placement: FramePlacement.optional(),
  type: z.literal('canvas.cut'),
  expected: z.object({
    endpoints: ContainerEndpointExpected.optional(),
    groups: z.record(Id, Id),
    containment: z.record(Id, Id.nullable()),
    items: z.record(Id, DeleteMember),
    connectors: z.record(Id, Id),
    frames: z.record(Id, Id).optional(),
  }).strict(),
  payload: z.object({
    cutId: Id,
    groupIds: z.array(Id),
    itemIds: z.array(Id),
    frameIds: z.array(Id).optional(),
  }).strict()
    .refine(value => value.groupIds.length + value.itemIds.length + (value.frameIds?.length ?? 0) > 0, '至少选择一个剪切目标')
    .refine(value => [value.groupIds, value.itemIds, value.frameIds ?? []].every(ids => new Set(ids).size === ids.length), '剪切目标重复'),
}).strict();

// 首次搬动只认服务端持久资格：客户端提交它读到的 cutRevision，竞争失败的请求不得退化成副本。
export const CanvasPasteCutCommand = z.object({
  commandId: Id,
  projectId: Id,
  placement: FramePlacement.optional(),
  type: z.literal('canvas.paste-cut'),
  expected: z.object({ cut: Id, cutRevision: z.number().int().nonnegative() }).strict(),
  payload: z.object({ cutId: Id, translation: Point }).strict(),
}).strict();

export const CutCommands = [CanvasCutCommand, CanvasPasteCutCommand] as const;
export type CanvasCut = z.infer<typeof CanvasCutCommand>;
export type CanvasPasteCut = z.infer<typeof CanvasPasteCutCommand>;
export type CutCommand = CanvasCut | CanvasPasteCut;

export interface CutRecord {
  projectId: string;
  cutId: string;
  versionId: string;
  state: CutState;
  revision: number;
  sourceRevision: number;
  createdAt: string;
}
export interface CutStateView {
  cutId: string;
  state: CutState;
  revision: number;
  sourceRevision: number;
}
