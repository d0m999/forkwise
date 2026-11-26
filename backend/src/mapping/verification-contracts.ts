import { z } from 'zod';

export const VerificationQuery = z.object({
  cik: z.string().trim().regex(/^0*[1-9]\d*$/).max(10).transform(value => value.padStart(10, '0')),
  taxonomy: z.string().trim().regex(/^[a-zA-Z0-9_-]+$/).max(80),
  tag: z.string().trim().regex(/^[a-zA-Z0-9_.-]+$/).max(240),
  unit: z.string().trim().regex(/^[a-zA-Z0-9_./%-]+$/).max(80),
  periodStart: z.iso.date().nullable(),
  periodEnd: z.iso.date(),
  knownByDate: z.iso.date(),
}).strict().refine(query => !query.periodStart || query.periodStart <= query.periodEnd, {
  message: '业务期间起日须早于或等于截止日', path: ['periodStart'],
});
export type VerificationQuery = z.infer<typeof VerificationQuery>;

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const VerificationOrigin = z.object({
  assetId: z.string().regex(/^sec-companyfacts:[a-f0-9]{64}$/),
  hash: Hash,
  fixture: z.literal(true).optional(),
}).strict();
export type VerificationOrigin = z.infer<typeof VerificationOrigin>;
export const VerificationBinding = z.object({
  id: z.string().min(1),
  origin: VerificationOrigin,
  contentHash: Hash,
}).strict();
export type VerificationBinding = z.infer<typeof VerificationBinding>;

export const VerificationCopySource = z.object({
  projectId: z.string().min(1).max(160),
  cardId: z.string().min(1).max(160),
  thoughtVersionId: z.string().min(1).max(160),
  bodyVersionId: z.string().min(1).max(160),
}).strict();

const SnapshotReceipt = VerificationOrigin.extend({
  sourceId: z.literal('sec-edgar'),
  url: z.url(),
  retrievedAt: z.iso.datetime(),
  adapterVersion: z.string(),
  httpLastModified: z.string().nullable(),
});

const numericLexeme = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
export const VerificationResult = z.object({
  catalogVersion: z.string(),
  evidence: z.discriminatedUnion('status', [
    z.object({ status: z.literal('not_accessed'), reason: z.string() }),
    z.object({ status: z.literal('access_failed'), reason: z.string(), code: z.string(), httpStatus: z.int().nullable() }),
    z.object({ status: z.literal('accessed'), receipt: SnapshotReceipt }),
    z.object({ status: z.literal('not_retained'), url: z.url(), hash: Hash, retrievedAt: z.iso.datetime(), reason: z.string() }),
  ]),
  coverage: z.enum(['unknown', 'no_coverage', 'insufficient', 'matched', 'conflicting']),
  subject: z.string().nullable(),
  matchedRecords: z.int().nonnegative(),
  records: z.array(z.object({
    rawValue: z.string().regex(numericLexeme).nullable(),
    accession: z.string(),
    filedOn: z.iso.date(),
    pointer: z.string(),
    form: z.string().nullable(),
  })),
  inference: z.literal('not_enabled'),
});
export type VerificationResult = z.infer<typeof VerificationResult>;
