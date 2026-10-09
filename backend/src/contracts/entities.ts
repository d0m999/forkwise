import type { ActionHistoryStatus } from './action-history.js';
import type { Layout } from './layout.js';
import { z } from '@hono/zod-openapi';

export const Id = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9_-]+$/);
export const Text = z.string().trim().min(1).max(100_000);
export const Time = z.iso.datetime({ offset: true });
export const Day = z.iso.date();
export const Ref = z.object({ id: Id, versionId: Id }).strict();
export const TextCitation = z
  .object({
    sourceVersionId: Id,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().max(20_000),
    unavailableReason: z.enum(['rights', 'missing']).optional(),
    visualRegionId: Id.optional(),
  })
  .strict()
  .refine(
    (c) => c.quote.length > 0 || c.unavailableReason !== undefined,
    '引用须保留原文或明确不可复核原因',
  );
export const ImageRegion = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001, '区域超出原图');
export const ImageCitation = z
  .object({
    kind: z.literal('image'),
    sourceVersionId: Id,
    fileId: Id,
    page: z.literal(1),
    imageWidth: z.number().int().positive(),
    imageHeight: z.number().int().positive(),
    region: ImageRegion,
    unavailableReason: z.enum(['rights', 'missing']).optional(),
  })
  .strict();
export const Citation = z.union([TextCitation, ImageCitation]);
export function isImageCitation(c: z.infer<typeof Citation>): c is z.infer<typeof ImageCitation> {
  return 'kind' in c && c.kind === 'image';
}
export const Stance = z
  .object({
    value: z.enum(['pending', 'accepted', 'questioned', 'rejected']),
    reason: z.string().max(20_000).default(''),
    reasonProvenance: z
      .object({ jobId: Id, proposalIndex: z.number().int().nonnegative(), modified: z.boolean() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (s) => !['questioned', 'rejected'].includes(s.value) || s.reason.trim().length > 0,
    '质疑或不认可必须填写理由',
  );
export const Attribution = {
  origin: z.enum(['user', 'author', 'ai']),
  participation: z.enum(['reference', 'candidate', 'personal']),
  stance: Stance,
  citations: z.array(Citation).max(100),
  editProvenance: z
    .object({
      jobId: Id,
      proposalIndex: z.number().int().nonnegative(),
      previous: Ref,
      scope: z.enum(['all', 'selected']),
      modified: z.boolean(),
    })
    .strict()
    .optional(),
};
export const Statement = z
  .object({
    text: Text,
    ...Attribution,
    lineage: Ref.optional(),
  })
  .strict();
export const Inference = z
  .object({
    premiseIds: z.array(Id).min(1).max(100),
    conclusionId: Id,
    reason: z.string().trim().max(100_000),
    combination: z.enum(['independent', 'joint_required', 'unspecified']),
    ...Attribution,
  })
  .strict();
export const Period = z
  .object({ start: Day, end: Day })
  .strict()
  .refine((p) => p.start <= p.end, '期间开始不得晚于结束');
export const NumericRule = z
  .object({
    subject: Text,
    metric: Text,
    operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
    threshold: z.number().finite(),
    unit: Text,
    currency: z.string().max(16),
    scope: Text,
    periodKind: z.enum(['single', 'cumulative', 'instant']),
    periods: z.array(Period).min(1).max(24),
  })
  .strict();
export const Condition = z
  .object({
    description: Text,
    mode: z.enum(['numeric', 'qualitative', 'mixed']),
    mixedCombination: z.enum(['joint_required', 'unspecified']).optional(),
    rule: NumericRule.optional(),
    targetIds: z
      .array(Id)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, '条件引用不可重复'),
    lineage: Ref.optional(),
  })
  .strict()
  .refine(
    (c) => (c.mode === 'qualitative' ? c.rule === undefined : c.rule !== undefined),
    '数值或混合条件需要结构化规则；定性条件不强制公式',
  );
export const Fact = z
  .object({
    subject: Text,
    metric: Text,
    value: z.number().finite().nullable(),
    rawValue: Text,
    unit: Text,
    currency: z.string().max(16),
    scope: Text,
    periodKind: z.enum(['single', 'cumulative', 'instant']),
    period: Period,
  })
  .strict();
export const Evidence = z.object({ citation: Citation, fact: Fact.optional() }).strict();
export const EvidenceLink = z
  .object({
    evidenceId: Id,
    target: Ref,
    context: z.array(Ref).max(101).optional(),
    relation: z.enum(['supports', 'opposes', 'qualifies', 'background', 'unjudged']),
    explanation: Text,
    origin: z.enum(['human', 'ai']).default('human'),
    participation: z.enum(['candidate', 'adopted']).default('adopted'),
  })
  .strict();
export const Verdict = z.enum([
  'satisfied',
  'not_satisfied',
  'awaiting_observation',
  'unknown',
  'not_comparable',
]);
export const AssessmentResult = z
  .object({
    verdict: Verdict,
    reason: Text,
    evidenceIds: z.array(Id).max(100),
    citations: z.array(Citation).max(100),
    missing: z.array(Text).max(100),
    tentative: z.boolean(),
  })
  .strict();
export const Evaluation = z
  .object({
    condition: Ref,
    evaluator: z.enum(['rule', 'ai', 'human']),
    verdict: Verdict,
    reason: Text,
    evidenceIds: z.array(Id).max(100),
    citations: z.array(Citation).max(100),
    missing: z.array(Text).max(100),
    evaluatedAt: Time,
    tentative: z.boolean(),
    basedOn: Ref.optional(),
    jobId: Id.optional(),
    components: z
      .object({ numeric: AssessmentResult, qualitative: AssessmentResult })
      .strict()
      .optional(),
  })
  .strict();
export const Source = z
  .object({
    title: Text,
    publisher: z.string().max(1000),
    url: z.url().optional(),
    rights: z.enum(['public', 'authorized', 'restricted']),
    reprintOf: Id.optional(),
  })
  .strict();
export const DataProvenance = z
  .object({
    provider: z.string().min(1).max(100),
    adapterVersion: z.string().min(1).max(200),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestUrl: z.url(),
    indexParent: z
      .object({ sourceVersionId: Id, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict();
export const SourceCoverage = z.enum(['full', 'excerpt', 'unknown']);
export const SourceVersion = z
  .object({
    sourceId: Id,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    textLength: z.number().int().nonnegative(),
    retrievedAt: Time,
    publishedAt: Time.nullable(),
    businessPeriod: Period.optional(),
    parseStatus: z.enum(['complete', 'partial', 'failed']),
    parseMessage: z.string().max(2000),
    coverage: SourceCoverage.optional(),
    provenance: DataProvenance.optional(),
    fileId: Id.optional(),
    normalizerVersion: z.string().max(100).optional(),
    textOrigin: z
      .enum(['pdf_text', 'html_body', 'ocr', 'human_correction', 'image_original'])
      .optional(),
    derivedFrom: Id.optional(),
  })
  .strict();
export const Note = z.object({ targetId: Id, text: Text }).strict();
export const MaterialMembership = z
  .object({
    targetId: Id,
    sourceVersionId: Id,
    visibility: z.enum(['included', 'excluded']),
  })
  .strict();
export const VerificationDetails = z
  .object({
    event: z.string().trim().min(1).max(2000).nullable(),
    goal: z.string().trim().min(1).max(2000).nullable(),
    period: z.string().trim().min(1).max(500).nullable(),
    date: Day.nullable(),
  })
  .strict();
export const VerificationNode = VerificationDetails.extend({
  target: Ref,
  context: z.array(Ref).max(101),
  status: z.enum(['candidate', 'confirmed']),
  gaps: z.array(z.string().min(1).max(2000)).max(30),
  basedOn: Ref.optional(),
  sourceTask: Id.optional(),
})
  .strict()
  .refine(
    (n) => n.status !== 'confirmed' || Boolean(n.event && n.goal),
    '确认节点需要明确事件和核对目标，期间与日期可以未知',
  )
  .refine(
    (n) => (n.status === 'candidate' ? !n.basedOn : !n.sourceTask && n.gaps.length === 0),
    '候选与本人确认的来源字段不能混用',
  );
export const ReviewDisposition = z.enum(['revised', 'maintained', 'later']);
export const Review = z
  .object({
    jobId: Id,
    proposalIndex: z.number().int().nonnegative().max(99),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    proposalTarget: Ref,
    target: Ref,
    context: z.array(Ref).max(101),
    disposition: ReviewDisposition,
    reason: z.string().trim().max(20_000),
    reviewedAt: Time,
  })
  .strict()
  .refine((r) => r.disposition === 'later' || r.reason.length > 0, '完成复核必须填写处理理由');
export const BodySchemas = {
  statement: Statement,
  inference: Inference,
  condition: Condition,
  evaluation: Evaluation,
  evidence: Evidence,
  evidence_link: EvidenceLink,
  source: Source,
  source_version: SourceVersion,
  note: Note,
  verification_node: VerificationNode,
  material_membership: MaterialMembership,
  review: Review,
};
export type Bodies = { [K in keyof typeof BodySchemas]: z.infer<(typeof BodySchemas)[K]> };
export type Kind = keyof Bodies;
export const KindSchema = z.enum(Object.keys(BodySchemas) as [Kind, ...Kind[]]);
export interface Entity<K extends Kind = Kind> {
  id: string;
  projectId: string;
  kind: K;
  version: number;
  versionId: string;
  contentVersionId: string;
  data: Bodies[K];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export type AnyEntity = { [K in Kind]: Entity<K> }[Kind];
export interface Project {
  id: string;
  name: string;
  question: string;
  revision: number;
  createdAt: string;
  deletedAt: string | null;
}
export const ActorSchema = z
  .object({
    id: Id,
    type: z.enum(['human', 'agent', 'system']),
    delegation: z
      .object({
        projectId: Id,
        capability: z.literal('personal_record'),
        issuedBy: z.literal('local-owner'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;
export interface ChangeSet {
  history?: ActionHistoryStatus;
  projectId: string;
  revisionBefore: number;
  revisionAfter: number;
  upserted: AnyEntity[];
  deletedIds: string[];
  layout?: Layout;
}
export interface State {
  project: Project;
  objects: AnyEntity[];
}
