import { z } from '@hono/zod-openapi';
import { Id, Ref, Time } from './entities.js';
import { Verification } from './research-tasks.js';

export const Applicability = z.enum(['current', 'stale', 'withdrawn', 'unbound']);
const count = z.number().int().nonnegative();
const Check = Verification.shape.checks.element;
const Binding = { target: Ref, context: z.array(Ref) };
export const ResearchSummary = z.object({
  ...Binding,
  evidence: z.object({ candidate: count, adopted: count, stale: count, unbound: count }),
  checks: z.object({ current: count, stale: count, withdrawn: count, unbound: count }),
  latest: z
    .object({
      jobId: Id,
      index: count,
      finishedAt: Time,
      relation: Check.shape.relation,
      aspect: Check.shape.aspect,
      explanationPreview: z.string().max(240),
    })
    .nullable(),
});
export const ResearchOverview = z
  .object({
    projectId: Id,
    revision: count,
    targets: z.array(ResearchSummary),
  })
  .strict()
  .openapi('ResearchOverview');
export const ResultsPage = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export const ObjectResearchResults = z
  .object({
    projectId: Id,
    revision: count,
    ...Binding,
    evidenceLinks: z.array(z.object({ id: Id, applicability: Applicability })),
    checks: z.array(
      z.object({
        jobId: Id,
        index: count,
        finishedAt: Time,
        applicability: Applicability,
        check: Check,
        taskGaps: z.array(z.string()),
        coverage: z.object({
          sourceVersionIds: z.array(Id),
          mode: z.string().nullable(),
          modelCalled: z.boolean().nullable(),
          networkQueries: z.array(z.string()),
        }),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ObjectResearchResults');
