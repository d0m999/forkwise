import { FramePlacement } from './frame-spatial.js';
import { z } from 'zod';

const Id = z.string().min(1).max(160);
export const Follower = z.object({
  kind: z.enum(['text', 'shape', 'image', 'stroke']),
  id: Id,
  itemId: Id,
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();
export const FollowerFields = {
  followers: z.array(Follower).optional(),
  expectedFollowers: z.record(Id, Id).optional(),
};
const Envelope = { commandId: Id, projectId: Id, placement: FramePlacement.optional() };
export const AttachmentCommands = z.discriminatedUnion('type', [
  z.object({
    ...Envelope,
    type: z.literal('attachment.attach'),
    expected: z.object({
      attachment: Id.nullable(),
      target: z.object({ itemId: Id, versionId: Id }).strict(),
      containment: Id.nullable(),
    }).strict(),
    payload: z.object({ itemId: Id, targetItemId: Id }).strict(),
  }).strict(),
  z.object({
    ...Envelope,
    type: z.literal('attachment.detach'),
    expected: z.object({
      attachment: Id,
      target: z.object({ itemId: Id, versionId: Id }).strict(),
    }).strict(),
    payload: z.object({ itemId: Id }).strict(),
  }).strict(),
]);
export type AttachmentCommand = z.infer<typeof AttachmentCommands>;
export type FollowerPose = z.infer<typeof Follower>;
export interface Attachment {
  id: string;
  versionId: string;
  target: { itemId: string } | null;
}
export type AttachmentChange = { before: Attachment | null; after: Attachment | null };
