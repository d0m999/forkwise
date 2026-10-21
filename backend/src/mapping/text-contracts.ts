import { z } from 'zod';
const Id = z.string().min(1).max(160);
export const TextContentSchema = z
  .object({
    runs: z.array(
      z
        .object({
          text: z.string(),
          bold: z.boolean().optional(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
        })
        .strict(),
    ),
    fontSize: z.number().finite().positive(),
    lineHeight: z.literal(1.5),
    align: z.enum(['left', 'center', 'right']),
    widthMode: z.enum(['auto', 'fixed']),
    width: z.number().finite().positive(),
  })
  .strict();
export const TextPoseSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();
const envelope = { commandId: Id, projectId: Id, editGroup: Id.optional() };
export const TextCommands = z.discriminatedUnion('type', [
  z
    .object({
      ...envelope,
      type: z.literal('text.layout'),
      expected: z.object({ text: Id, pose: Id }).strict(),
      payload: z
        .object({
          id: Id,
          width: z.number().finite().positive(),
          height: z.number().finite().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('text.copy'),
      expected: z.object({ text: Id, pose: Id }).strict(),
      payload: z.object({ id: Id, copyId: Id }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('text.delete'),
      expected: z.object({ text: Id, pose: Id }).strict(),
      payload: z.object({ id: Id }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('text.move'),
      expected: Id,
      payload: z.object({ id: Id, x: z.number().finite(), y: z.number().finite() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('text.transform'),
      expected: z.object({ text: Id, pose: Id }).strict(),
      payload: z.object({ id: Id, content: TextContentSchema, pose: TextPoseSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('text.create'),
      expected: z.null(),
      payload: z.object({ id: Id, content: TextContentSchema, pose: TextPoseSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('text.edit'),
      expected: Id,
      payload: z.object({ id: Id, content: TextContentSchema }).strict(),
    })
    .strict(),
]);
export type TextCommand = z.infer<typeof TextCommands>;
export type TextContent = z.infer<typeof TextContentSchema>;
export interface CanvasText {
  id: string;
  kind: 'text';
  versionId: string;
  content: TextContent;
  item: {
    id: string;
    versionId: string;
    createdOrder?: number;
    pose: z.infer<typeof TextPoseSchema>;
  };
}
export type TextChange = { before: CanvasText | null; after: CanvasText | null };
