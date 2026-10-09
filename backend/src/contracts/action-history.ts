import { z } from '@hono/zod-openapi';
import { Id, Time, ActorSchema } from './entities.js';
import { LayoutData } from './layout.js';

const summary = z.object({ id: Id, label: z.string().min(1).max(200) }).strict();
export const ActionHistoryStatus = z
  .object({
    version: z.number().int().nonnegative(),
    undo: summary.nullable(),
    redo: summary.nullable(),
  })
  .strict();
export const HistoryTravel = z
  .object({
    direction: z.enum(['undo', 'redo']),
    expectedRevision: z.number().int().nonnegative(),
    expectedHistoryVersion: z.number().int().nonnegative(),
    expectedLayoutVersion: z.number().int().nonnegative(),
  })
  .strict();
export const ActionJournal = z
  .object({
    version: z.number().int().nonnegative(),
    cursor: z.number().int().min(0).max(40),
    entries: z
      .array(
        summary
          .extend({
            at: Time,
            workflowId: Id.optional(),
            actor: ActorSchema,
            objects: z
              .array(z.object({ id: Id, before: Id.nullable(), after: Id }).strict())
              .max(100_000),
            layout: z.object({ before: LayoutData, after: LayoutData }).strict().optional(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict()
  .refine((v) => v.cursor <= v.entries.length, '撤销游标超出历史范围');
export type ActionJournal = z.infer<typeof ActionJournal>;
export type ActionHistoryStatus = z.infer<typeof ActionHistoryStatus>;

export const WorkflowGroupArchive = z
  .object({
    id: Id,
    rootJobId: Id,
    applied: z.boolean(),
    stopped: z.boolean(),
    taskIds: z.array(Id).min(2).max(10_000),
  })
  .strict();
