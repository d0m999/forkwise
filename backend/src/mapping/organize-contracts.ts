import { z } from 'zod';
import { VerificationQuery, VerificationResult } from './verification-contracts.js';

const Id = z.string().min(1).max(160);
const DisclosureId = z.string().regex(/^[a-f0-9]{64}$/).optional();
const Mode = z.enum(['real', 'simulate']);
export const ORGANIZE_MAX_INPUT = 24_000;
export const OrganizeRequest = z.object({
  requestId: Id,
  mode: Mode,
  cardId: Id,
  thoughtVersionId: Id,
  bodyVersionId: Id,
  includeTitle: z.boolean(),
  blockIds: z.array(Id).max(100),
  verification: VerificationQuery.optional(),
  disclosureId: DisclosureId,
}).strict().refine(request => !request.verification ||
  (request.mode === 'real' && !request.includeTitle && !request.blockIds.length), {
  message: '公开查证仅发送已确认的查询条件，请勿选择卡片文字',
});

export const OrganizeOutput = z.object({
  candidate: z.object({
    title: z.string().trim().min(1).max(240),
    text: z.string().trim().min(1).max(16_000),
  }).strict().nullable(),
  gaps: z.array(z.string().trim().min(1).max(1000)).max(20),
}).strict();

export const OrganizeOrigin = z.object({
  taskId: Id.optional(),
  mode: Mode,
}).strict();

export type OrganizeRequest = z.infer<typeof OrganizeRequest>;
export type OrganizeSendDisclosure = { id: string; retention: string };
export type OrganizeStatus = {
  model: string | null;
  blockedReason: string | null;
  sendDisclosure?: OrganizeSendDisclosure;
  verificationFixture?: true;
};
export const OrganizeRetry = z.object({ attempt: z.int().positive(), requestId: Id, disclosureId: DisclosureId }).strict();
export const OrganizeCancel = z.object({ attempt: z.int().positive() }).strict();
export type OrganizeOutput = z.infer<typeof OrganizeOutput> & {
  verification?: z.infer<typeof VerificationResult>;
};
export type OrganizeOrigin = z.infer<typeof OrganizeOrigin>;
export type OrganizeInput = Pick<OrganizeRequest, 'cardId' | 'thoughtVersionId' | 'bodyVersionId'> & {
  title: string | null;
  blocks: { id: string; text: string }[];
  omittedBlockCount: number;
};
export const OrganizeProviderRequestId = z.string().max(128).regex(/^req_[a-zA-Z0-9_-]+$/);
export const OrganizeUsage = z.object({
  attempts: z.array(z.object({
    model: z.string(),
    requestedModel: z.string().optional(),
    returnedModel: z.string().nullable().optional(),
    phase: z.enum(['generate', 'repair']).optional(),
    inputTokens: z.int().nonnegative().nullable(),
    cachedInputTokens: z.int().nonnegative().nullish(),
    outputTokens: z.int().nonnegative().nullable(),
    responseReceived: z.boolean().optional(),
    providerRequestId: OrganizeProviderRequestId.optional(),
  })),
  cost: z.null(),
  modelDigest: z.string().optional(),
});
export type OrganizeUsage = z.infer<typeof OrganizeUsage>;
export type OrganizeTask = {
  id: string;
  cardId: string;
  mode: OrganizeOrigin['mode'];
  model: string | null;
  input: OrganizeInput;
  verification?: VerificationQuery;
  verificationFixture?: true;
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  output: OrganizeOutput | null;
  outputAttempt: number | null;
  usage: OrganizeUsage | null;
  attempts: {
    number: number;
    state: OrganizeTask['state'];
    requestedAt: string;
    finishedAt: string | null;
    usage: OrganizeUsage | null;
    output: OrganizeOutput | null;
    error: string | null;
  }[];
  error: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  applied: boolean;
  candidateOnCanvas: boolean;
  addAvailable: boolean;
  cutCopyAvailable: boolean;
  freshness: 'current' | 'changed' | 'deleted';
};
export type OrganizeSummary = Pick<OrganizeTask, 'id' | 'cardId' | 'mode' | 'createdAt' | 'verificationFixture'>;
export type OrganizeTaskView = OrganizeTask & { retryBlockedReason: string | null };
