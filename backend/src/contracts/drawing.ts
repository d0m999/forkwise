import { z } from '@hono/zod-openapi';
import { Id } from './entities.js';
export const BasicDrawing = z
  .object({
    id: Id,
    type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'line', 'arrow', 'freedraw', 'image']),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().nonnegative().max(100000),
    height: z.number().nonnegative().max(100000),
    text: z.string().max(10000).default(''),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .default('#63776d'),
    points: z.array(z.array(z.number().finite()).length(2)).min(2).max(10000).optional(),
    fileId: Id.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.type === 'image' && !v.fileId)
      c.addIssue({ code: 'custom', message: '图片需引用项目原文件' });
  });
export const DrawingOperations = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    commands: z
      .array(
        z.discriminatedUnion('op', [
          z.object({ op: z.literal('drawing.put'), drawing: BasicDrawing }).strict(),
          z.object({ op: z.literal('drawing.delete'), id: Id }).strict(),
          z
            .object({
              op: z.literal('object.position'),
              id: Id,
              x: z.number().finite(),
              y: z.number().finite(),
              width: z.number().positive().optional(),
              height: z.number().positive().optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict();
