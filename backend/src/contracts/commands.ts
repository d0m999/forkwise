import { LayoutInput } from './layout.js';
import { z } from '@hono/zod-openapi';
import {
  Id,
  Text,
  Stance,
  Statement,
  Inference,
  Condition,
  Evidence,
  EvidenceLink,
  Source,
  SourceCoverage,
  Time,
  Period,
  Verdict,
  Citation,
  Ref,
  DataProvenance,
  VerificationDetails,
  ReviewDisposition,
} from './entities.js';

const create = <const O extends string, S extends z.ZodType>(op: O, schema: S) =>
  z.object({ op: z.literal(op), id: Id, data: schema }).strict();
const CreateStatement = create('statement.create', Statement);
const CreateInference = create('inference.create', Inference);
const CreateCondition = create('condition.create', Condition);
const CreateSource = create('source.create', Source);
const CreateEvidence = create('evidence.create', Evidence);
const CreateEvidenceLink = create('evidence.link', EvidenceLink);
export const Command = z
  .discriminatedUnion('op', [
    z
      .object({
        op: z.literal('impact.review'),
        id: Id,
        jobId: Id,
        proposalIndex: z.number().int().nonnegative().max(99),
        target: Ref,
        context: z.array(Ref).max(101),
        disposition: ReviewDisposition,
        reason: z.string().trim().max(20_000),
      })
      .strict(),
    CreateStatement,
    CreateInference,
    CreateCondition,
    CreateSource,
    CreateEvidence,
    CreateEvidenceLink,
    z
      .object({
        op: z.literal('evidence.relate'),
        id: Id,
        relation: EvidenceLink.shape.relation,
        explanation: Text,
      })
      .strict(),
    z
      .object({
        op: z.literal('verification.propose'),
        id: Id,
        target: Ref,
        context: z.array(Ref).max(101),
        details: VerificationDetails,
        gaps: z.array(z.string().min(1).max(2000)).max(30),
        sourceTask: Id.optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal('verification.confirm'),
        id: Id,
        target: Ref,
        context: z.array(Ref).max(101),
        details: VerificationDetails,
        basedOn: Ref.optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal('impact.adopt'),
        id: Id,
        jobId: Id,
        proposalIndex: z.number().int().nonnegative(),
        text: Text,
        scope: z.enum(['all', 'selected']),
        newId: Id.optional(),
        inferenceIds: z.array(Id).max(100).default([]),
      })
      .strict(),
    z.object({ op: z.literal('statement.copy'), id: Id, newId: Id }).strict(),
    z
      .object({ op: z.literal('statement.edit'), id: Id, text: Text, scope: z.literal('all') })
      .strict(),
    z
      .object({
        op: z.literal('statement.derive'),
        id: Id,
        newId: Id,
        text: Text,
        inferenceIds: z.array(Id).min(1).max(100),
      })
      .strict(),
    z
      .object({
        op: z.literal('inference.edit'),
        id: Id,
        premiseIds: z.array(Id).min(1).max(100),
        conclusionId: Id,
        reason: Inference.shape.reason,
        combination: Inference.shape.combination,
      })
      .strict(),
    z.object({ op: z.literal('stance.set'), id: Id, stance: Stance }).strict(),
    z.object({ op: z.literal('object.adopt'), id: Id }).strict(),
    z.object({ op: z.literal('evidence.adopt'), id: Id }).strict(),
    z.object({ op: z.literal('object.delete'), id: Id }).strict(),
    z
      .object({ op: z.literal('condition.edit'), id: Id, scope: z.literal('all'), data: Condition })
      .strict(),
    z
      .object({
        op: z.literal('condition.derive'),
        id: Id,
        newId: Id,
        targetIds: z.array(Id).min(1).max(100),
        data: Condition,
      })
      .strict(),
    z
      .object({
        op: z.literal('source.import'),
        id: Id,
        sourceId: Id,
        text: z.string().min(1).max(5_000_000),
        retrievedAt: Time,
        publishedAt: Time.nullable(),
        businessPeriod: Period.optional(),
        provenance: DataProvenance.optional(),
        coverage: SourceCoverage.optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal('source.parse'),
        provenance: DataProvenance.optional(),
        id: Id,
        sourceId: Id,
        fileId: Id,
        text: z.string().max(5_000_000),
        normalizerVersion: z.string().min(1).max(100),
        textOrigin: z.enum(['pdf_text', 'html_body', 'ocr', 'human_correction', 'image_original']),
        derivedFrom: Id.optional(),
        status: z.enum(['complete', 'partial', 'failed']),
        message: z.string().max(2000),
      })
      .strict(),
    z
      .object({
        op: z.literal('evaluation.propose'),
        id: Id,
        condition: Ref,
        verdict: Verdict,
        reason: Text,
        evidenceIds: z.array(Id).max(100),
        citations: z.array(Citation).max(100),
        missing: z.array(Text).max(100),
        tentative: z.boolean(),
      })
      .strict(),
    z
      .object({
        op: z.literal('evaluation.confirm'),
        id: Id,
        condition: Ref,
        evaluationId: Id.optional(),
        verdict: Verdict,
        reason: Text,
        evidenceIds: z.array(Id).max(100),
        citations: z.array(Citation).max(100),
      })
      .strict(),
    z.object({ op: z.literal('note.create'), id: Id, targetId: Id, text: Text }).strict(),
    z
      .object({ op: z.literal('material.attach'), id: Id, targetId: Id, sourceVersionId: Id })
      .strict(),
    z.object({ op: z.literal('material.hide'), id: Id }).strict(),
  ])
  .openapi('Command');
export const WriteRequest = z
  .object({
    expected: z.record(Id, z.number().int().positive()),
    commands: z.array(Command).max(100),
    layout: LayoutInput.optional(),
  })
  .strict()
  .refine((v) => v.commands.length > 0 || v.layout !== undefined, {
    message: '请提供业务操作或布局变更',
  })
  .openapi('WriteRequest');
export type CommandInput = z.infer<typeof Command>;
export type WriteInput = z.infer<typeof WriteRequest>;
export const ProjectInput = z
  .object({ name: Text, question: z.string().max(20_000).default('') })
  .strict();
