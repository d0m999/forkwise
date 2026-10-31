import { z } from 'zod';

const Id = z.string().min(1).max(160);
export const LayerOperationSchema = z.enum(['front', 'back', 'forward', 'backward']);
export const LayerOrderCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('canvas.layer'),
  expected: z.record(Id, Id),
  payload: z.object({
    itemIds: z.array(Id).min(1).max(500),
    operation: LayerOperationSchema,
  }).strict(),
}).strict();
export type LayerOperation = z.infer<typeof LayerOperationSchema>;
