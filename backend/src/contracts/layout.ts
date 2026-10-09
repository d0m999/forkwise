import { z } from '@hono/zod-openapi';
import { Id } from './entities.js';

// Native drawing data is an opaque presentation asset. Research objects always
// come from the graph projection and cannot be injected through this layer.
const record = z.record(z.string(), z.unknown());
const color = z.string().regex(/^(?:#[0-9a-fA-F]{3,8}|transparent)$/);
const style = z
  .object({
    strokeColor: color.optional(),
    backgroundColor: color.optional(),
    fillStyle: z.enum(['solid', 'hachure', 'cross-hatch', 'zigzag']).optional(),
    strokeWidth: z.number().min(0).max(20).optional(),
    strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
    roughness: z.number().min(0).max(3).optional(),
    opacity: z.number().min(0).max(100).optional(),
    fontFamily: z.number().int().positive().optional(),
    fontSize: z.number().positive().max(1000).optional(),
    textAlign: z.enum(['left', 'center', 'right']).optional(),
  })
  .strict();
const view = z
  .object({
    relationIds: z.array(Id).optional(),
    scrollX: z.number().finite(),
    scrollY: z.number().finite(),
    zoom: z.object({ value: z.number().positive().max(100) }).strict(),
    selectedElementIds: z.record(z.string(), z.boolean()),
    selectedGroupIds: z.record(z.string(), z.boolean()),
    viewBackgroundColor: color.optional(),
    theme: z.enum(['light', 'dark']).optional(),
  })
  .strict();
export const CanvasData = z
  .object({
    scenes: z.record(
      z.string(),
      z
        .object({
          styles: z.record(z.string(), style),
          frames: z.record(z.string(), z.string()).optional(),
          view: view.optional(),
        })
        .strict(),
    ),
    annotations: z
      .object({ elements: z.array(record).max(10_000), files: z.record(z.string(), record) })
      .strict(),
    drafts: z.record(z.string(), record).optional(),
    attachments: z
      .record(
        z.string(),
        z
          .object({
            target: Id,
            mode: z.enum(['mine', 'author']),
            x: z.number().finite(),
            y: z.number().finite(),
          })
          .strict(),
      )
      .optional(),
    returnViews: z
      .record(z.string(), view.extend({ count: z.number().int().nonnegative() }))
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (JSON.stringify(value).length > 12_000_000)
      context.addIssue({ code: 'custom', message: '画布资产超过 12 MB，请将大图片作为原文件导入' });
    const types = new Set([
      'rectangle',
      'ellipse',
      'diamond',
      'text',
      'arrow',
      'line',
      'freedraw',
      'image',
      'frame',
      'magicframe',
    ]);
    for (const element of value.annotations.elements) {
      if (
        typeof element.id !== 'string' ||
        !types.has(String(element.type)) ||
        !Number.isFinite(element.x) ||
        !Number.isFinite(element.y) ||
        (element.customData as Record<string, unknown> | undefined)?.forkwisePart
      ) {
        context.addIssue({ code: 'custom', message: '自由绘图含无效元素或伪装的研究对象' });
      }
      if (typeof element.link === 'string' && !/^https?:\/\//i.test(element.link))
        context.addIssue({ code: 'custom', message: '绘图链接只支持 HTTP(S)' });
    }
    for (const file of Object.values(value.annotations.files)) {
      if (
        typeof file.dataURL !== 'string' ||
        !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(file.dataURL)
      )
        context.addIssue({
          code: 'custom',
          message: '画布图片必须是本地 PNG、JPEG、GIF 或 WebP 数据',
        });
    }
  });
export const LayoutData = z
  .object({
    positions: z.record(
      Id,
      z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().positive().optional(),
          height: z.number().positive().optional(),
        })
        .strict(),
    ),
    drawings: z
      .array(
        z
          .object({
            id: Id,
            type: z.enum(['rectangle', 'ellipse', 'text', 'arrow']),
            x: z.number().finite(),
            y: z.number().finite(),
            width: z.number().finite(),
            height: z.number().finite(),
            text: z.string().max(10_000).default(''),
            color: z
              .string()
              .regex(/^#[a-fA-F0-9]{6}$/)
              .default('#63776d'),
          })
          .strict(),
      )
      .max(10_000),
    canvas: CanvasData.optional(),
    ports: z
      .record(
        Id,
        z
          .object({
            premises: z.record(Id, z.enum(['top', 'right', 'bottom', 'left'])),
            conclusion: z.enum(['top', 'right', 'bottom', 'left']).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const LayoutSchema = z
  .object({ version: z.number().int().nonnegative(), data: LayoutData })
  .strict();
export const LayoutInput = z
  .object({ expectedVersion: z.number().int().nonnegative(), data: LayoutData })
  .strict();
export type Layout = z.infer<typeof LayoutSchema>;
