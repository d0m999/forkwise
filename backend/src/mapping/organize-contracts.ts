import { z } from 'zod';

const Id = z.string().min(1).max(160);
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
}).strict();

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
export const OrganizeRetry = z.object({ attempt: z.int().positive(), requestId: Id }).strict();
export const OrganizeCancel = z.object({ attempt: z.int().positive() }).strict();
export type OrganizeOutput = z.infer<typeof OrganizeOutput>;
export type OrganizeOrigin = z.infer<typeof OrganizeOrigin>;
export type OrganizeInput = Pick<OrganizeRequest, 'cardId' | 'thoughtVersionId' | 'bodyVersionId'> & {
  title: string | null;
  blocks: { id: string; text: string }[];
  omittedBlockCount: number;
};
export const OrganizeUsage = z.object({
  attempts: z.array(z.object({
    model: z.string(),
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    responseReceived: z.boolean().optional(),
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
  freshness: 'current' | 'changed' | 'deleted';
};
export type OrganizeSummary = Pick<OrganizeTask, 'id' | 'cardId' | 'mode' | 'createdAt'>;
