import { ActionJournal, WorkflowGroupArchive } from './action-history.js';
import { z } from '@hono/zod-openapi';
import { Id, Time, Text } from './entities.js';
import { EntitySchema, ProjectSchema, JobSchema } from './responses.js';

import { LayoutSchema } from './layout.js';
export { LayoutData, LayoutSchema, LayoutInput } from './layout.js';
export const JudgmentSummary = z.object({ id: Id, title: Text, createdAt: Time }).strict();
export const JudgmentSchema = JudgmentSummary.extend({ objects: z.array(EntitySchema) });
export const SearchInput = z
  .object({
    query: z.string().min(1).max(2000),
    asOf: Time.optional(),
    vector: z
      .object({
        model: z.string().min(1).max(200),
        values: z.array(z.number().finite()).min(1).max(8192),
      })
      .strict()
      .optional(),
  })
  .strict();
export const SearchResult = z.object({
  mode: z.enum(['full_text', 'hybrid']),
  results: z.array(
    z.object({
      chunkId: z.number().int(),
      entityId: Id,
      versionId: Id,
      kind: z.string(),
      start: z.number().int(),
      end: z.number().int(),
      text: z.string(),
      retrievalScore: z.number(),
    }),
  ),
});
export const ArchiveSchema = z
  .object({
    format: z.literal('forkwise-project'),
    schemaVersion: z.literal(1),
    exportedAt: Time,
    project: ProjectSchema,
    objects: z.array(EntitySchema).max(100_000),
    versions: z
      .array(
        z
          .object({
            snapshot: EntitySchema,
            actor: z.object({ id: Id, type: z.enum(['human', 'agent', 'system']) }).strict(),
          })
          .strict(),
      )
      .max(1_000_000),
    materials: z
      .array(
        z
          .object({
            id: Id,
            text: z.string().max(5_000_000).nullable(),
            omission: z.string().max(2000).optional(),
          })
          .strict(),
      )
      .max(100_000),
    files: z
      .array(
        z
          .object({
            id: Id,
            sourceId: Id,
            name: z.string().max(255),
            mime: z.string().max(100),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            base64: z.string().max(34_000_000).nullable(),
            retrievedAt: Time,
            publishedAt: Time.nullable(),
            omission: z.string().optional(),
          })
          .strict(),
      )
      .max(100_000)
      .default([]),
    artifacts: z
      .array(
        z
          .object({ sourceVersionId: Id, fileId: Id, data: z.record(z.string(), z.unknown()) })
          .strict(),
      )
      .max(100_000)
      .default([]),
    tasks: z
      .array(JobSchema.extend({ dedupeKey: z.string() }))
      .max(100_000)
      .default([]),
    layout: LayoutSchema,
    actionHistory: ActionJournal.optional(),
    workflowGroups: z.array(WorkflowGroupArchive).max(100_000).default([]),
    judgments: z
      .array(JudgmentSummary.extend({ refs: z.string().max(10_000_000) }).strict())
      .max(100_000),
  })
  .strict()
  .openapi('ProjectArchive');
export type Archive = z.infer<typeof ArchiveSchema>;
