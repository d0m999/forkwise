import { FramePlacement } from './frame-spatial.js';
import { MembershipExpected } from './containment-contracts.js';
import { z } from 'zod';

const Id = z.string().min(1).max(160);
export const ImageCropSchema = z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1),
}).strict().refine(c => c.x + c.width <= 1 && c.y + c.height <= 1, '裁剪范围不能超出原图');
export const ImagePoseSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().positive(), height: z.number().finite().positive(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
}).strict();
export const ImageContentSchema = z.object({ assetId: Id, crop: ImageCropSchema }).strict();
export const ImageCommands = z.discriminatedUnion('type', [
  z.object({ commandId: Id, projectId: Id, placement: FramePlacement.optional(), type: z.literal('image.crop'), expected: z.object({ image: Id, pose: Id }).strict(),
    payload: z.object({ id: Id, crop: ImageCropSchema }).strict() }).strict(),
  z.object({ commandId: Id, projectId: Id, placement: FramePlacement.optional(), type: z.literal('image.delete'), expected: z.object({ image: Id, pose: Id, connectors: z.record(Id, Id).optional(), membership: MembershipExpected.optional() }).strict(),
    payload: z.object({ id: Id }).strict() }).strict(),
  z.object({ commandId: Id, projectId: Id, placement: FramePlacement.optional(), type: z.literal('image.rotate'), expected: z.object({ image: Id, pose: Id }).strict(),
    payload: z.object({ id: Id, direction: z.enum(['left', 'right']) }).strict() }).strict(),
  z.object({ commandId: Id, projectId: Id, placement: FramePlacement.optional(), type: z.literal('image.transform'), expected: z.object({ image: Id, pose: Id }).strict(),
    payload: z.object({ id: Id, pose: ImagePoseSchema.omit({ rotation: true }) }).strict() }).strict(),
  z.object({ commandId: Id, projectId: Id, placement: FramePlacement.optional(), type: z.literal('image.create'), expected: z.null(),
    payload: z.object({ id: Id, content: ImageContentSchema, pose: ImagePoseSchema }).strict() }).strict(),
]);
export type ImageCommand = z.infer<typeof ImageCommands>;
export interface CanvasImage {
  id: string;
  kind: 'image';
  versionId: string;
  content: z.infer<typeof ImageContentSchema>;
  item: { id: string; versionId: string; createdOrder: number; pose: z.infer<typeof ImagePoseSchema> };
}
export type ImageChange = { before: CanvasImage | null; after: CanvasImage | null };
export type ImageVersion = Pick<CanvasImage, 'id' | 'versionId' | 'content'>;
