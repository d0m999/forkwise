import { z } from '@hono/zod-openapi';
import { Id, Ref, Text, Time, VerificationDetails } from './entities.js';
import { PublicDataInput } from './public-data.js';
import { MaterialRetrieval } from './research-tasks.js';
import { FilingFilter, SecFilingInput, SecHistoryInput } from './sec-filings.js';

export const InitialResearchInput = z
  .object({
    sourceVersionIds: z.array(Id).min(1).max(20),
    asOf: Time.optional(),
    retrieval: MaterialRetrieval.optional(),
  })
  .strict();

export const SourcePlan = z
  .object({
    targets: z
      .array(
        z
          .object({
            target: Ref,
            classification: z.enum(['fact', 'prediction', 'inference']),
            period: VerificationDetails.shape.period,
            verificationEvent: VerificationDetails.shape.event,
            verificationGoal: VerificationDetails.shape.goal.default(null),
            verificationDate: VerificationDetails.shape.date.default(null),
            requests: z
              .array(
                PublicDataInput.omit({ refresh: true })
                  .extend({
                    filings: FilingFilter.optional(),
                  })
                  .refine(
                    (request) => !request.filings || request.dataset === 'submissions',
                    '只有申报索引可以选取正文',
                  ),
              )
              .max(3),
            queries: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
            gaps: z.array(Text).max(30),
          })
          .strict(),
      )
      .max(100),
    gaps: z.array(Text).max(100),
  })
  .strict();

export type SourcePlanResult = z.infer<typeof SourcePlan>;
export interface WorkflowContext {
  owner: string;
  asOf?: string;
  targets?: SourcePlanResult['targets'];
}

export function verificationAspect(
  classification: SourcePlanResult['targets'][number]['classification'],
) {
  return classification === 'prediction'
    ? 'current_basis'
    : classification === 'inference'
      ? 'inference_basis'
      : 'reported_fact';
}

export const InitialFilingsProgress = z
  .object({
    selections: z
      .array(
        z
          .object({
            targetId: z.string(),
            indexSourceVersionId: z.string(),
            filter: FilingFilter,
            documents: z.array(SecFilingInput).max(10),
            state: z.enum(['selected', 'failed']),
            matchedRecords: z.number().int().nonnegative().nullable(),
            historyFileCount: z.number().int().nonnegative().nullable(),
            gaps: z.array(z.string()),
          })
          .strict(),
      )
      .max(3300),
    acquisitions: z
      .array(
        z
          .object({
            request: SecFilingInput,
            indexBindings: z.array(SecFilingInput).min(1).max(11).optional(),
            url: z.string(),
            jobId: z.string().optional(),
            sourceVersionId: z.string().optional(),
            state: z.enum(['pending', 'available', 'failed', 'not_known']),
            error: z.string().optional(),
            gaps: z.array(z.string()),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export const InitialHistoryProgress = z
  .object({
    selections: z
      .array(
        z
          .object({
            targetId: Id,
            indexSourceVersionId: Id,
            filter: FilingFilter,
            fileNames: z.array(z.string()).max(10),
            excludedFiles: z.number().int().nonnegative().nullable(),
            listedFiles: z.number().int().nonnegative().nullable(),
            state: z.enum(['selected', 'failed']),
            gaps: z.array(z.string()),
          })
          .strict(),
      )
      .max(300),
    acquisitions: z
      .array(
        z
          .object({
            request: SecHistoryInput,
            url: z.string(),
            cik: z.string(),
            jobId: Id.optional(),
            sourceVersionId: Id.optional(),
            state: z.enum(['pending', 'available', 'failed', 'not_known']),
            error: z.string().optional(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
