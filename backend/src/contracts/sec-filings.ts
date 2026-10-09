import { z } from '@hono/zod-openapi';
import { Id } from './entities.js';
export const SecHistoryInput = z
  .object({
    indexSourceVersionId: Id,
    fileName: z.string().regex(/^CIK\d{10}-submissions-\d{3,6}\.json$/),
  })
  .strict();
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
    '日期无效',
  );
export const FilingFilter = z
  .object({
    forms: z
      .array(z.string().trim().min(1).max(30))
      .min(1)
      .max(10)
      .refine((forms) => new Set(forms).size === forms.length, '类型重复'),
    filedFrom: Day,
    filedThrough: Day,
    includeHistory: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => value.filedFrom <= value.filedThrough, '披露日期范围颠倒');
export const SecFilingInput = z
  .object({
    indexSourceVersionId: Id,
    accessionNumber: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
  })
  .strict();
