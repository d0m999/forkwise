import { recordAction } from '../repositories/action-history.js';
import { readLayout } from '../repositories/layout.js';
import { randomUUID } from 'node:crypto';
import type { AnyEntity, Entity, ChangeSet } from '../contracts/entities.js';
import { AssessmentResult, Evaluation, isImageCitation } from '../contracts/entities.js';
import { type Assessment, evaluateNumeric, combineMixed } from '../domain/numeric-evaluation.js';
import { requireThat, DomainError } from '../domain/errors.js';
import { ofKind } from '../domain/graph.js';
import { WriteContext } from '../domain/write-context.js';
import type { ResearchRepository } from '../repositories/research.js';
import { JobRepository, type Job } from '../repositories/jobs.js';
import { digest } from './graph-write.js';

export interface AgentEvaluator {
  evaluate(
    input: EvaluationInput,
    signal: AbortSignal,
  ): Promise<{ assessment: Assessment; usage: unknown }>;
}
export interface EvaluationInput {
  condition: Entity<'condition'>;
  evidence: Entity<'evidence'>[];
  metrics: string[];
  numericAssessment?: Assessment;
}
export class EvaluationService {
  private running = new Map<string, AbortController>();
  private stopping = false;
  constructor(
    readonly repo: ResearchRepository,
    readonly jobs: JobRepository,
    readonly metrics: () => string[],
    readonly agent?: AgentEvaluator,
  ) {}
  request(
    projectId: string,
    conditionId: string,
    evidenceIds: string[],
    expectedRule: string,
  ): Job {
    return this.repo.db
      .transaction(() => {
        const objects = new Map(this.repo.snapshot(projectId).objects.map((e) => [e.id, e]));
        const condition = ofKind(objects, conditionId, 'condition');
        requireThat(
          condition.contentVersionId === expectedRule,
          'STALE_RULE',
          '规则已改变，请重新读取',
          409,
        );
        requireThat(
          new Set(evidenceIds).size === evidenceIds.length,
          'DUPLICATE_INPUT',
          '评估输入不可重复',
        );
        const evidence = evidenceIds.map((id) => ofKind(objects, id, 'evidence'));
        const input = { condition, evidence, metrics: this.metrics() };
        const kind = condition.data.mode === 'numeric' ? 'condition.rule' : 'condition.agent';
        return this.jobs.enqueue(projectId, kind, input, digest({ kind, input }));
      })
      .immediate();
  }
  autoEnqueue(c: WriteContext, changed: AnyEntity[]): void {
    for (const e of changed) {
      if (e.kind !== 'condition' || e.deletedAt || e.data.mode !== 'numeric' || !e.data.rule)
        continue;
      const before = c.original.get(e.id);
      if (
        !before ||
        before.kind !== 'condition' ||
        !before.data.rule ||
        before.data.rule.threshold === e.data.rule.threshold
      )
        continue;
      const { threshold: oldThreshold, ...oldRule } = before.data.rule;
      const { threshold: newThreshold, ...newRule } = e.data.rule;
      if (digest(oldRule) !== digest(newRule)) continue;
      const evidence = [...c.objects.values()].filter(
        (x): x is Entity<'evidence'> =>
          x.kind === 'evidence' &&
          !x.deletedAt &&
          x.data.fact?.metric === newRule.metric &&
          x.data.fact.subject === newRule.subject &&
          newRule.periods.some(
            (p) => p.start === x.data.fact!.period.start && p.end === x.data.fact!.period.end,
          ),
      );
      const assessment = evaluateNumeric(e.data.rule, evidence, c.now, this.metrics());
      if (!['satisfied', 'not_satisfied'].includes(assessment.verdict)) continue;
      const input = { condition: e, evidence, metrics: this.metrics() };
      this.jobs.enqueue(
        c.projectId,
        'condition.rule',
        input,
        digest({ kind: 'condition.rule', input }),
      );
    }
  }
  async run(projectId: string, id: string): Promise<Job> {
    const job = this.jobs.claim(projectId, id);
    if (!job) return this.jobs.get(projectId, id);
    const abort = new AbortController();
    this.running.set(job.id, abort);
    try {
      const input = job.input as EvaluationInput;
      let assessment: Assessment;
      let components: { numeric: Assessment; qualitative: Assessment } | undefined;
      let usage: unknown = null;
      if (job.kind === 'condition.rule') {
        requireThat(input.condition.data.rule, 'INVALID_RULE', '缺少结构化规则');
        assessment = evaluateNumeric(
          input.condition.data.rule,
          input.evidence,
          this.jobs.clock(),
          input.metrics,
        );
      } else {
        requireThat(
          !input.evidence.some((e) => isImageCitation(e.data.citation)),
          'IMAGE_NOT_REVIEWED',
          '此评估接口尚未传入原图；请先核对转写或由具备原图访问能力的外部 Agent 提交候选',
        );
        requireThat(
          this.agent,
          'PROVIDER_NOT_CONFIGURED',
          '尚未配置符合数据处理要求的模型；规则已保存，可通过外部 Agent 提交候选',
          503,
        );
        if (input.condition.data.mode === 'mixed') {
          requireThat(input.condition.data.rule, 'INVALID_RULE', '缺少混合条件的数值规则');
          const numeric = evaluateNumeric(
            input.condition.data.rule,
            input.evidence.filter((e) => e.data.fact),
            this.jobs.clock(),
            input.metrics,
          );
          const result = await this.agent.evaluate(
            { ...input, numericAssessment: numeric },
            abort.signal,
          );
          const qualitative = AssessmentResult.parse(result.assessment);
          usage = result.usage;
          components = { numeric, qualitative };
          assessment = combineMixed(numeric, qualitative);
        } else ({ assessment, usage } = await this.agent.evaluate(input, abort.signal));
      }
      this.repo.db
        .transaction(() => {
          if (!this.jobs.isRunning(job)) {
            this.jobs.recordDiscardedUsage(job, usage);
            return;
          }
          const context = new WriteContext(
            this.repo,
            projectId,
            { id: `job_${job.id}`, type: 'system' },
            {},
            this.jobs.clock(),
          );
          const condition = context.get(input.condition.id);
          requireThat(
            condition.kind === 'condition',
            'CONDITION_REMOVED',
            '条件已删除，不应用晚到结果',
          );
          const data = Evaluation.parse({
            ...assessment,
            condition: { id: input.condition.id, versionId: input.condition.contentVersionId },
            evaluator: job.kind === 'condition.rule' ? 'rule' : 'ai',
            evaluatedAt: context.now,
            jobId: job.id,
            ...(components ? { components } : {}),
          });
          for (const citation of data.citations) {
            requireThat(
              input.evidence.some((e) => digest(e.data.citation) === digest(citation)),
              'UNBOUND_CITATION',
              '评估引用了本任务未提供的材料片段',
            );
            context.citation(citation);
          }
          for (const evidenceId of data.evidenceIds) {
            requireThat(
              input.evidence.some((e) => e.id === evidenceId),
              'UNBOUND_EVIDENCE',
              '评估引用了任务范围外的证据',
            );
            ofKind(context.objects, evidenceId, 'evidence');
          }
          const evaluation = context.add(randomUUID(), 'evaluation', data);
          const project = this.repo.project(projectId);
          this.repo.persist([evaluation], context.actor, new Map());
          this.repo.db.prepare('UPDATE projects SET revision=revision+1 WHERE id=?').run(projectId);
          const changes: ChangeSet = {
            projectId,
            revisionBefore: project.revision,
            revisionAfter: project.revision + 1,
            upserted: [evaluation],
            deletedIds: [],
          };
          const layout = readLayout(this.repo, projectId);
          recordAction(
            this.repo,
            projectId,
            context.actor,
            context.now,
            context.original,
            [evaluation],
            layout,
            layout,
            '新增条件评估结果',
          );
          this.jobs.finish(job, 'succeeded', { evaluationId: evaluation.id, changes }, null, usage);
        })
        .immediate();
    } catch (error) {
      this.jobs.finish(
        job,
        'failed',
        null,
        error instanceof DomainError
          ? `${error.code}: ${error.message}`
          : '评估执行失败；已保存规则保持，可重试计算',
        error instanceof DomainError ? error.details : null,
      );
    } finally {
      this.running.delete(job.id);
    }
    return this.jobs.get(projectId, id);
  }
  cancel(projectId: string, id: string): Job {
    const job = this.jobs.cancel(projectId, id);
    this.running.get(id)?.abort();
    return job;
  }
  stop() {
    this.stopping = true;
    for (const controller of this.running.values()) controller.abort();
  }
  async drain(): Promise<void> {
    const queued = this.repo.db
      .prepare(
        "SELECT project_id,id FROM jobs WHERE state='queued' AND kind IN ('condition.rule','condition.agent') ORDER BY created_at,id",
      )
      .all() as { project_id: string; id: string }[];
    for (const job of queued) {
      if (this.stopping) break;
      await this.run(job.project_id, job.id);
    }
  }
}
