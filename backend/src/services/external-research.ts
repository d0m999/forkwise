import { randomUUID } from 'node:crypto';
import { ExternalSubmit, ExternalEvaluationInput } from '../contracts/external-research.js';
import { AssessmentResult } from '../contracts/entities.js';
import { evaluateNumeric, combineMixed } from '../domain/numeric-evaluation.js';
import { digest } from '../domain/canonical.js';
import type { EvaluationService, EvaluationInput } from './evaluation.js';
import { Reconstruction, Verification, Impact, StanceDraft } from '../contracts/research-tasks.js';
import type { Actor } from '../contracts/entities.js';
import type { ResearchTaskService, TaskScope } from './research-tasks.js';
import { requireThat } from '../domain/errors.js';

const schemas = {
  reconstruct: Reconstruction,
  verify: Verification,
  impact: Impact,
  stance_draft: StanceDraft,
};
export class ExternalResearchService {
  constructor(
    readonly research: ResearchTaskService,
    readonly evaluation: EvaluationService,
  ) {}
  requestEvaluation(projectId: string, actor: Actor, key: string, raw: unknown) {
    const input = ExternalEvaluationInput.parse(raw),
      { write, jobs } = this.research;
    return write.idempotent(actor, projectId, key, { op: 'external.evaluation', input }, () => {
      jobs.assertCapacity(projectId);
      const objects = write.repo.snapshot(projectId).objects;
      const condition = objects.find((e) => e.id === input.conditionId);
      requireThat(
        condition?.kind === 'condition' && condition.contentVersionId === input.ruleVersionId,
        'STALE_RULE',
        '条件不属于当前版本',
        409,
      );
      requireThat(
        condition.data.mode !== 'numeric',
        'DETERMINISTIC_RULE_REQUIRED',
        '数值条件请使用确定性评估接口',
      );
      requireThat(
        new Set(input.evidenceIds).size === input.evidenceIds.length,
        'DUPLICATE_INPUT',
        '证据不能重复',
      );
      const evidence = input.evidenceIds.map((id) => {
        const e = objects.find((e) => e.id === id);
        requireThat(e?.kind === 'evidence', 'EVIDENCE_NOT_FOUND', '证据不属于项目', 404);
        return e;
      });
      const targets = objects.filter((e) => condition.data.targetIds.includes(e.id));
      const context = objects.filter((e) =>
        targets.some(
          (t) =>
            t.kind === 'inference' && [...t.data.premiseIds, t.data.conclusionId].includes(e.id),
        ),
      );
      return {
        ...jobs.enqueue(
          projectId,
          'condition.agent',
          {
            condition,
            evidence,
            sourceVersionIds: [...new Set(evidence.map((e) => e.data.citation.sourceVersionId))],
            metrics: this.evaluation.metrics(),
            targets,
            context,
            external: { executor: 'external', createdBy: actor.id, retryOf: null, serverReads: [] },
          },
          `external-evaluation:${actor.id}:${key}`,
        ),
        runToken: null,
      };
    });
  }
  request(projectId: string, actor: Actor, key: string, input: unknown) {
    return this.research.request(projectId, actor, key, input, undefined, undefined, undefined, {
      executor: 'external',
      createdBy: actor.id,
      retryOf: null,
      serverReads: [],
    });
  }
  private owned(projectId: string, actor: Actor, id: string) {
    const job = this.research.jobs.get(projectId, id),
      scope = job.input as TaskScope;
    requireThat(
      scope.external?.executor === 'external',
      'NOT_EXTERNAL_TASK',
      '此记录不是外部研究',
      409,
    );
    requireThat(
      scope.external.createdBy === actor.id || actor.type === 'human',
      'EXECUTOR_FORBIDDEN',
      '只有创建 Agent 或本人可操作此研究记录',
      403,
    );
    return { job, scope };
  }
  recordRead(
    projectId: string,
    actor: Actor,
    id: string,
    read: { sourceVersionId: string; [key: string]: unknown },
  ) {
    this.research.write.repo.db
      .transaction(() => {
        const { job, scope } = this.owned(projectId, actor, id);
        requireThat(job.state === 'queued', 'TASK_CLOSED', '此研究已结束', 409);
        // 旧评估记录未保存材料集合，仍以任务固定的证据派生范围。
        if (job.kind === 'condition.agent' && !scope.sourceVersionIds)
          scope.sourceVersionIds = [
            ...new Set(
              (job.input as EvaluationInput).evidence.map((e) => e.data.citation.sourceVersionId),
            ),
          ];
        requireThat(
          scope.sourceVersionIds?.includes(read.sourceVersionId),
          'MATERIAL_OUTSIDE_TASK',
          '材料不在固定研究范围',
          403,
        );
        requireThat(
          scope.external!.serverReads.length < 1000,
          'READ_LOG_LIMIT',
          '读取记录已达上限，请新建任务',
        );
        scope.external!.serverReads.push({ ...read, servedAt: this.research.jobs.clock() });
        this.research.write.repo.db
          .prepare('UPDATE jobs SET input=? WHERE project_id=? AND id=?')
          .run(JSON.stringify(scope), projectId, id);
      })
      .immediate();
  }
  submit(projectId: string, actor: Actor, key: string, id: string, raw: unknown) {
    const input = ExternalSubmit.parse(raw),
      { write, jobs } = this.research;
    return write.idempotent(actor, projectId, key, { op: 'external.submit', id, input }, () => {
      const { job, scope } = this.owned(projectId, actor, id);
      requireThat(
        job.state === 'queued',
        'TASK_CLOSED',
        '任务已取消或已有结果，不能提交晚到结果',
        409,
      );
      const current = new Map(write.repo.snapshot(projectId).objects.map((e) => [e.id, e]));
      let stale = [...scope.targets, ...scope.context].some(
        (e) => current.get(e.id)?.contentVersionId !== e.contentVersionId,
      );
      let result: unknown = null,
        changes: unknown = null;
      if (input.state !== 'failed') {
        if (job.kind === 'condition.agent') {
          const fixed = job.input as EvaluationInput;
          stale ||=
            current.get(fixed.condition.id)?.contentVersionId !==
              fixed.condition.contentVersionId ||
            fixed.evidence.some((e) => current.get(e.id)?.contentVersionId !== e.contentVersionId);
          const qualitative = AssessmentResult.parse(input.result);
          requireThat(
            qualitative.evidenceIds.every((id) => fixed.evidence.some((e) => e.id === id)) &&
              qualitative.citations.every((c) =>
                fixed.evidence.some((e) => digest(e.data.citation) === digest(c)),
              ),
            'UNBOUND_EVIDENCE',
            '评估只能引用固定证据',
          );
          const numeric =
            fixed.condition.data.mode === 'mixed'
              ? evaluateNumeric(
                  fixed.condition.data.rule!,
                  fixed.evidence.filter((e) => e.data.fact),
                  jobs.clock(),
                  fixed.metrics,
                )
              : undefined;
          const assessment =
            numeric && fixed.condition.data.mixedCombination === 'joint_required'
              ? combineMixed(numeric, qualitative)
              : qualitative;
          const components = numeric ? { numeric, qualitative } : undefined;
          result = {
            ...assessment,
            ...(components ? { components } : {}),
            inputVerification: 'agent_inputs_unverified',
          };
          if (!stale)
            changes = write.execute(
              projectId,
              actor,
              `evaluation_${id}`,
              {
                expected: Object.fromEntries(
                  [fixed.condition, ...fixed.evidence].map((e) => [
                    e.id,
                    current.get(e.id)!.version,
                  ]),
                ),
                commands: [
                  {
                    op: 'evaluation.propose',
                    id: `assessment_${id}`,
                    condition: {
                      id: fixed.condition.id,
                      versionId: fixed.condition.contentVersionId,
                    },
                    ...assessment,
                    ...(components ? { components } : {}),
                  },
                ],
              },
              undefined,
              true,
            );
        } else {
          result = schemas[scope.kind].parse(input.result);
          this.research.validateCitations(result, scope, projectId);
          if (scope.kind === 'verify') {
            const checks = Verification.parse(result).checks;
            requireThat(
              new Set(checks.map((c) => c.target.id)).size === checks.length,
              'DUPLICATE_CHECK',
              '同一目标只能提交一份核对',
            );
            requireThat(
              input.state === 'partial' || checks.length === scope.targets.length,
              'INCOMPLETE_COVERAGE',
              '未逐项回应时请提交 partial 并列明缺口',
            );
          }
          if (!stale && scope.kind === 'reconstruct')
            changes = this.research.reconstruct(projectId, id, Reconstruction.parse(result), actor);
          if (!stale && scope.kind === 'verify')
            changes = this.research.verification(
              projectId,
              id,
              Verification.parse(result),
              scope,
              actor,
            );
        }
      }
      const output = {
        result,
        changes,
        stale,
        gaps: input.gaps,
        coverage: {
          sourceVersionIds: scope.sourceVersionIds,
          serverReads: scope.external!.serverReads,
          agentReported: input.agentCoverage,
          modelCalled: false,
        },
        message: stale
          ? '结果保存至固定旧版本，未应用当前图谱'
          : '外部研究结果已保存，个人判断独立',
      };
      jobs.db
        .prepare(
          "UPDATE jobs SET state=?,output=?,error=?,usage=?,attempt=attempt+1,updated_at=? WHERE project_id=? AND id=? AND state='queued'",
        )
        .run(
          input.state,
          JSON.stringify(output),
          input.error ?? null,
          JSON.stringify({ agentReported: input.agentUsage, verified: false }),
          jobs.clock(),
          projectId,
          id,
        );
      return { ...jobs.get(projectId, id), runToken: null };
    });
  }
  action(projectId: string, actor: Actor, key: string, id: string, action: 'cancel' | 'retry') {
    const { write, jobs } = this.research;
    return write.idempotent(actor, projectId, key, { op: `external.${action}`, id }, () => {
      const { job, scope } = this.owned(projectId, actor, id);
      if (action === 'cancel') return { ...jobs.cancel(projectId, id), runToken: null };
      requireThat(
        ['failed', 'partial', 'interrupted', 'cancelled'].includes(job.state),
        'JOB_NOT_RETRYABLE',
        '只有未完成研究可另建重试记录',
        409,
      );
      jobs.assertCapacity(projectId);
      const next = structuredClone(scope);
      next.external = { executor: 'external', createdBy: actor.id, retryOf: id, serverReads: [] };
      return {
        ...jobs.enqueue(projectId, job.kind, next, `external-retry:${randomUUID()}`),
        runToken: null,
      };
    });
  }
}
