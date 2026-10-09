import { z } from '@hono/zod-openapi';

export const PublicDataInput = z
  .object({
    sourceId: z.literal('sec-edgar'),
    cik: z
      .string()
      .regex(/^\d{1,10}$/)
      .refine((v) => Number(v) > 0),
    dataset: z.enum(['companyfacts', 'submissions']),
    refresh: z.literal(true),
  })
  .strict();
