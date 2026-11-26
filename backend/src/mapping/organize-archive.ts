import { z } from 'zod';
import { OrganizeOrigin, OrganizeUsage } from './organize-contracts.js';
import { VerificationQuery, VerificationResult } from './verification-contracts.js';

const Id = z.string().min(1);
const State = z.enum(['running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted']);
const Output = z.object({
  candidate: z.object({ title: z.string(), text: z.string() }).nullable(),
  gaps: z.array(z.string()),
  verification: VerificationResult.optional(),
}).nullable();
const Usage = OrganizeUsage.nullable();
const AttemptNumber = z.int().positive();

// 历史输出只按归档形状检查，兼容旧结果（如无候选且无缺口）。
const Task = z.object({
  id: Id,
  cardId: Id,
  mode: OrganizeOrigin.shape.mode,
  model: z.string().nullable(),
  verification: VerificationQuery.optional(),
  verificationFixture: z.literal(true).optional(),
  input: z.object({
    cardId: Id,
    thoughtVersionId: Id,
    bodyVersionId: Id,
    title: z.string().nullable(),
    blocks: z.array(z.object({ id: Id, text: z.string() })),
    omittedBlockCount: z.int().nonnegative(),
  }),
  state: State,
  output: Output,
  outputAttempt: AttemptNumber.nullable(),
  usage: Usage,
  attempts: z.array(z.object({
    number: AttemptNumber,
    state: State,
    requestedAt: z.string(),
    finishedAt: z.string().nullable(),
    usage: Usage,
    output: Output,
    error: z.string().nullable(),
  })),
  error: z.string().nullable(),
  attempt: AttemptNumber,
  createdAt: z.string(),
  updatedAt: z.string(),
  applied: z.boolean(),
  candidateOnCanvas: z.boolean(),
  addAvailable: z.boolean().optional(),
  cutCopyAvailable: z.boolean().optional(),
  freshness: z.enum(['current', 'changed', 'deleted']),
});

export const OrganizeArchiveImportCheck = z.array(z.object({ projectId: Id, tasks: z.array(Task) }));
