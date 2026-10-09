import { z } from '@hono/zod-openapi';
import { Id, Text, TextCitation, Ref } from './entities.js';

export const MaterialRetrieval = z
  .object({
    queries: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
    maxCharacters: z.number().int().min(20_000).max(200_000).default(80_000),
  })
  .strict();

export const ResearchTaskInput = z
  .object({
    kind: z.enum(['reconstruct', 'verify', 'impact', 'stance_draft']),
    sourceVersionIds: z.array(Id).min(1).max(30),
    targetIds: z.array(Id).max(100),
    retrieval: MaterialRetrieval.optional(),
  })
  .strict();
const cited = { citations: z.array(TextCitation).max(30), gaps: z.array(Text).max(30) };
const fragment = { key: Id, text: Text, origin: z.enum(['author', 'ai']), ...cited };
export const Reconstruction = z
  .object({
    statements: z.array(z.object(fragment).strict()).max(100),
    inferences: z
      .array(
        z
          .object({
            key: Id,
            premiseKeys: z.array(Id).min(1).max(30),
            conclusionKey: Id,
            reason: Text,
            combination: z.enum(['independent', 'joint_required', 'unspecified']),
            origin: z.enum(['author', 'ai']),
            ...cited,
          })
          .strict(),
      )
      .max(100),
    gaps: z.array(Text).max(100),
  })
  .strict();
export const Verification = z
  .object({
    checks: z
      .array(
        z
          .object({
            target: Ref,
            relation: z.enum(['supports', 'opposes', 'qualifies', 'background', 'insufficient']),
            explanation: Text,
            aspect: z.enum(['reported_fact', 'current_basis', 'inference_basis']).optional(),
            ...cited,
          })
          .strict(),
      )
      .max(100),
    gaps: z.array(Text).max(100),
  })
  .strict();
export const Impact = z
  .object({
    proposals: z
      .array(z.object({ target: Ref, proposedText: Text, reason: Text, ...cited }).strict())
      .max(100),
    gaps: z.array(Text).max(100),
  })
  .strict();
export const StanceDraft = z
  .object({
    proposals: z.array(z.object({ target: Ref, reason: Text, ...cited }).strict()).max(100),
    gaps: z.array(Text).max(100),
  })
  .strict();
