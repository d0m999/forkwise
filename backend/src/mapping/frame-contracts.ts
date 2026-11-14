import { FollowerFields } from './attachment-contracts.js';
import { FramePlacement } from './frame-spatial.js';
import { ContainerEndpointExpected } from './container-endpoints.js';
import { z } from 'zod';

const Id = z.string().min(1).max(160);
const Pose = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();
export const FrameCommands = z.discriminatedUnion('type', [
  z.object({ commandId: Id, projectId: Id, type: z.literal('frame.resize'), placement: FramePlacement, expected: Id,
    payload: z.object({ id: Id, pose: Pose }).strict() }).strict(),
  z.object({
    commandId: Id,
    projectId: Id,
    placement: FramePlacement.optional(),
    type: z.literal('frame.create'),
    expected: z.object({
      frame: z.null(),
      groups: z.record(Id, Id),
      containment: z.record(Id, Id.nullable()),
      poses: z.record(Id, Id),
    }).strict(),
    payload: z.object({ id: Id, itemIds: z.array(Id), pose: Pose, parentId: Id.nullable().optional() }).strict(),
  }).strict(),
  z.object({
    commandId: Id,
    projectId: Id,
    placement: FramePlacement.optional(),
    ...FollowerFields,
    type: z.literal('frame.move'),
    expected: z.object({
      frame: Id,
      groups: z.record(Id, Id),
      containment: z.record(Id, Id),
      poses: z.record(Id, Id),
    }).strict(),
    payload: z.object({ id: Id, dx: z.number().finite(), dy: z.number().finite() }).strict(),
  }).strict(),
  z.object({
    commandId: Id,
    projectId: Id,
    placement: FramePlacement.optional(),
    type: z.literal('frame.delete'),
    expected: z.object({ endpoints: ContainerEndpointExpected.optional(), frame: Id, containment: z.record(Id, Id) }).strict(),
    payload: z.object({ id: Id }).strict(),
  }).strict(),
  z.object({
    commandId: Id,
    projectId: Id,
    placement: FramePlacement.optional(),
    type: z.literal('frame.edit'),
    expected: Id,
    payload: z.object({ id: Id, name: z.string().trim().min(1).max(240), background: z.string().nullable() }).strict(),
  }).strict(),
]);
export type FrameCommand = z.infer<typeof FrameCommands>;
export interface FrameRecord {
  id: string;
  versionId: string;
  name: string;
  background: string | null;
  pose: z.infer<typeof Pose>;
}
export interface CanvasFrame extends FrameRecord {
  kind: 'frame';
  memberItemIds: string[];
}
export type FrameChange = { before: FrameRecord | null; after: FrameRecord | null };
