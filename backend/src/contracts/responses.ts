import { ActionHistoryStatus } from './action-history.js';
import { LayoutSchema } from './layout.js';
import { z } from '@hono/zod-openapi';
import { BodySchemas, Id, Time, Ref, type Kind } from './entities.js';

const envelope = <const K extends Kind>(kind: K) =>
  z.object({
    id: Id,
    projectId: Id,
    kind: z.literal(kind),
    version: z.number().int().positive(),
    versionId: Id,
    contentVersionId: Id,
    data: BodySchemas[kind],
    createdAt: Time,
    updatedAt: Time,
    deletedAt: Time.nullable(),
  });
export const EntitySchema = z
  .union([
    envelope('statement'),
    envelope('inference'),
    envelope('condition'),
    envelope('evaluation'),
    envelope('evidence'),
    envelope('evidence_link'),
    envelope('source'),
    envelope('source_version'),
    envelope('note'),
    envelope('verification_node'),
    envelope('material_membership'),
    envelope('review'),
  ])
  .openapi('ResearchObject');
export const ProjectSchema = z
  .object({
    id: Id,
    name: z.string(),
    question: z.string(),
    revision: z.number().int(),
    createdAt: Time,
    deletedAt: Time.nullable(),
  })
  .openapi('Project');
export const ChangesSchema = z
  .object({
    projectId: Id,
    revisionBefore: z.number().int(),
    revisionAfter: z.number().int(),
    upserted: z.array(EntitySchema),
    deletedIds: z.array(Id),
    layout: LayoutSchema.optional(),
    history: ActionHistoryStatus.optional(),
  })
  .openapi('ChangeSet');
export const StateSchema = z
  .object({ project: ProjectSchema, objects: z.array(EntitySchema) })
  .openapi('ResearchState');
export const WorkspaceSchema = z
  .object({ state: StateSchema, layout: LayoutSchema, history: ActionHistoryStatus })
  .strict()
  .openapi('ResearchWorkspace');
export const JobSchema = z
  .object({
    id: Id,
    projectId: Id,
    kind: z.string(),
    state: z.enum([
      'queued',
      'running',
      'succeeded',
      'partial',
      'failed',
      'cancelled',
      'interrupted',
    ]),
    input: z.unknown(),
    output: z.unknown(),
    error: z.string().nullable(),
    attempt: z.number().int(),
    runToken: z.null(),
    createdAt: Time,
    updatedAt: Time,
    usage: z.unknown(),
    historyState: z.enum(['applied', 'undone', 'stopped']).optional(),
  })
  .openapi('Job');
export const ErrorSchema = z
  .object({ code: z.string(), data: z.unknown().nullable(), message: z.string() })
  .openapi('Error');
export const JobSummarySchema = JobSchema.omit({
  input: true,
  output: true,
  runToken: true,
})
  .extend({ condition: Ref.optional(), executor: z.string().nullable().optional() })
  .openapi('JobSummary');
export const SyncSchema = z
  .object({
    projectId: Id,
    revision: z.number().int().nonnegative(),
    changes: z.array(ChangesSchema).max(100),
    needsSnapshot: z.boolean(),
    layout: LayoutSchema.nullable(),
    history: ActionHistoryStatus,
  })
  .strict()
  .openapi('ProjectSync');
export const response = <S extends z.ZodType>(data: S) =>
  z.object({ code: z.literal('OK'), data, message: z.string() });
export const ok = <T>(data: T) => ({ code: 'OK' as const, data, message: '' });
