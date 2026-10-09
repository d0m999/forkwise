import { z } from '@hono/zod-openapi';
import { Id, Text, AssessmentResult } from './entities.js';
import { Reconstruction, Verification, Impact, StanceDraft } from './research-tasks.js';
export const ExternalEvaluationInput = z
  .object({ conditionId: Id, ruleVersionId: Id, evidenceIds: z.array(Id).max(100) })
  .strict();
export const ExternalSubmit = z
  .object({
    state: z.enum(['succeeded', 'partial', 'failed']),
    result: z
      .union([Reconstruction, Verification, Impact, StanceDraft, AssessmentResult])
      .optional(),
    error: Text.optional(),
    gaps: z.array(Text).max(100),
    agentCoverage: z.record(z.string(), z.unknown()).default({}),
    agentUsage: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.state !== 'failed' && !v.result)
      c.addIssue({ code: 'custom', message: '完成或部分完成须提交该任务的结构化结果' });
    if (v.state === 'failed' && !v.error) c.addIssue({ code: 'custom', message: '失败需说明原因' });
    if (v.state === 'partial' && !v.gaps.length)
      c.addIssue({ code: 'custom', message: '部分完成需列明缺口' });
  });
