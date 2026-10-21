import { z } from 'zod';

const Id = z.string().min(1).max(160);
const StrokeContent = z.object({
  penKind: z.enum(['pen', 'highlighter']),
  path: z.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()).min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  width: z.number().finite().positive(),
  opacity: z.number().finite().min(0).max(1),
}).strict();
const StrokePose = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();
export const StrokeCreateCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('stroke.create'),
  expected: z.null(),
  payload: z.object({ id: Id, content: StrokeContent, pose: StrokePose }).strict(),
}).strict();
export const StrokeDeleteCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('stroke.delete'),
  expected: z.object({ stroke: Id, pose: Id }).strict(),
  payload: z.object({ id: Id }).strict(),
}).strict();
export interface CanvasStroke {
  id: string;
  kind: 'stroke';
  versionId: string;
  content: z.infer<typeof StrokeContent>;
  item: {
    id: string;
    versionId: string;
    createdOrder: number;
    pose: z.infer<typeof StrokePose>;
  };
}
export type StrokeChange = { before: CanvasStroke | null; after: CanvasStroke | null };
export type StrokeVersion = Pick<CanvasStroke, 'id' | 'versionId' | 'content'>;
