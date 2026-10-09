import { z } from '@hono/zod-openapi';
import { Id, Time, SourceCoverage, Ref } from './entities.js';
import { ChangesSchema } from './responses.js';
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ManualUpdateInput = z
  .object({
    scopeLabel: z.string().trim().min(1).max(200),
    material: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('existing'), sourceVersionId: Id }).strict(),
      z
        .object({
          kind: z.literal('text'),
          sourceId: Id,
          text: z
            .string()
            .min(1)
            .max(1_000_000)
            .refine((v) => v.trim().length > 0),
          retrievedAt: Time,
          publishedAt: Time.nullable(),
          coverage: SourceCoverage,
        })
        .strict(),
    ]),
    targetIds: z.array(Id).min(1).max(100),
  })
  .strict();
export const ManualUpdateRequest = ManualUpdateInput.extend({ previewHash: Hash });
export const UpdateBinding = z.object({ target: Ref, context: z.array(Ref).max(101) }).strict();
export const UpdateScope = z
  .object({
    schemaVersion: z.literal(1),
    cancelledJobIds: z.array(Id).max(1),
    cancelledFingerprint: Hash.optional(),
    eventKey: Hash,
    sourceId: Id,
    sourceVersionId: Id,
    materialHash: Hash,
    scopeLabel: z.string().min(1).max(200),
    bindings: z.array(UpdateBinding).min(1).max(100),
  })
  .strict();
export type UpdateScope = z.infer<typeof UpdateScope>;
const DisplayTarget = z.object({
  id: Id,
  kind: z.enum(['statement', 'inference']),
  text: z.string(),
  versionId: Id,
});
export const ManualUpdatePreview = z.object({
  projectId: Id,
  eventKey: Hash,
  previewHash: Hash,
  scopeLabel: z.string(),
  sourceId: Id,
  sourceTitle: z.string(),
  sourceVersionId: Id.nullable(),
  newMaterial: z.boolean(),
  publishedAt: Time.nullable(),
  retrievedAt: Time,
  materialHash: Hash,
  coverage: SourceCoverage,
  targets: z.array(DisplayTarget),
  context: z.array(DisplayTarget),
  newTargetIds: z.array(Id),
  existingJobIds: z.array(Id),
  downstream: z.object({
    count: z.number().int(),
    items: z.array(DisplayTarget),
    truncated: z.boolean(),
  }),
  estimate: z.object({
    materialCharacters: z.number().int(),
    targetContextCharacters: z.number().int(),
    newTaskCount: z.number().int(),
    estimatedCost: z.null(),
    costStatus: z.literal('unknown'),
  }),
  gaps: z.array(z.string()),
});
export const ManualUpdateResult = z.object({
  eventKey: Hash,
  sourceVersionId: Id,
  createdJobId: Id.nullable(),
  existingJobIds: z.array(Id),
  changes: ChangesSchema,
  message: z.string(),
});
export const UpdatePage = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(1024).optional(),
});
export const UpdateEvents = z.object({
  items: z.array(
    z.object({
      eventKey: Hash,
      sourceId: Id,
      sourceTitle: z.string(),
      materialHash: Hash,
      firstAt: Time,
      latestAt: Time,
      taskCount: z.number().int(),
      proposalCount: z.number().int(),
      activeCount: z.number().int(),
      blockedCount: z.number().int(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const UpdateTasks = z.object({
  items: z.array(
    z.object({
      id: Id,
      state: z.string(),
      createdAt: Time,
      error: z.string().nullable(),
      scopeLabel: z.string(),
      sourceVersionId: Id,
      targetIds: z.array(Id),
      proposalCount: z.number().int(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
