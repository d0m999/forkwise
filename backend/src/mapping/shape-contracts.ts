import { z } from 'zod';

const Id = z.string().min(1).max(160);
const ShapeContentSchema = z.object({
  shapeType: z.enum(['rectangle', 'roundedRectangle', 'ellipse', 'diamond', 'triangle']),
  shortText: z.string(),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  stroke: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWidth: z.number().finite().positive().optional(),
}).strict();
const ShapePoseSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();
export const ShapeCreateCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('shape.create'),
  expected: z.null(),
  payload: z.object({ id: Id, content: ShapeContentSchema, pose: ShapePoseSchema }).strict(),
}).strict();
export const ShapeEditCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('shape.edit'),
  expected: Id,
  payload: z.object({ id: Id, content: ShapeContentSchema }).strict(),
}).strict();
export const ShapeMoveCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('shape.move'),
  expected: Id,
  payload: z.object({ id: Id, x: z.number().finite(), y: z.number().finite() }).strict(),
}).strict();
export const ShapeDeleteCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('shape.delete'),
  expected: z.object({ shape: Id, pose: Id }).strict(),
  payload: z.object({ id: Id }).strict(),
}).strict();
export const ShapeTransformCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('shape.transform'),
  expected: Id,
  payload: z.object({ id: Id, pose: ShapePoseSchema }).strict(),
}).strict();
export type ShapeCommand = z.infer<typeof ShapeCreateCommand> | z.infer<typeof ShapeEditCommand> | z.infer<typeof ShapeMoveCommand> | z.infer<typeof ShapeDeleteCommand> | z.infer<typeof ShapeTransformCommand>;
export interface CanvasShape {
  id: string;
  kind: 'shape';
  versionId: string;
  content: z.infer<typeof ShapeContentSchema>;
  item: {
    id: string;
    versionId: string;
    createdOrder: number;
    pose: z.infer<typeof ShapePoseSchema>;
  };
}
export type ShapeChange = { before: CanvasShape | null; after: CanvasShape | null };
export type ShapeVersion = Pick<CanvasShape, 'id' | 'versionId' | 'content'>;
