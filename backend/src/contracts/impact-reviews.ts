import { z } from '@hono/zod-openapi';
import { Id, Ref, Stance, Time } from './entities.js';
import { EntitySchema } from './responses.js';
import { Impact } from './research-tasks.js';
export const ImpactReviewPage = z
  .object({
    targetId: Id.optional(),
    jobId: Id.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export const ImpactReviews = z.object({
  projectId: Id,
  revision: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      jobId: Id,
      proposalIndex: z.number().int().nonnegative(),
      createdAt: Time,
      proposal: Impact.shape.proposals.element,
      originalText: z.string(),
      originalContext: z.array(z.object({ id: Id, text: z.string() })),
      proposalState: z.enum(['current', 'stale', 'unavailable']),
      reviewState: z.enum(['pending', 'later', 'completed', 'stale']),
      current: z
        .object({
          expected: z.record(Id, z.number().int().positive()),
          target: Ref,
          context: z.array(Ref),
          text: z.string(),
          stance: Stance,
          contextTexts: z.array(z.object({ id: Id, text: z.string() })),
        })
        .nullable(),
      review: EntitySchema.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
