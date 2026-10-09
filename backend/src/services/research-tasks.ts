import type { UpdateScope } from '../contracts/manual-updates.js';
import { readSecIndex } from './sec-index.js';
import { linkWorkflowTask, taskWorkflow, workflowGroup } from '../repositories/workflow-history.js';
import type { CorrectionTrigger } from './correction-impact.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  ResearchTaskInput,
  Reconstruction,
  Verification,
  Impact,
  StanceDraft,
} from '../contracts/research-tasks.js';
import { TextCitation, type Actor, type AnyEntity } from '../contracts/entities.js';
import type { CommandInput } from '../contracts/commands.js';
import type { GraphWriteService } from './graph-write.js';
import { digest } from './graph-write.js';
import type { JobRepository } from '../repositories/jobs.js';
import { requireThat, DomainError } from '../domain/errors.js';
import { verificationAspect, type WorkflowContext } from '../contracts/initial-research.js';
import { SearchRepository } from '../repositories/search.js';
import {
  validateCompanyFactPassages,
  validateSubmissionPassages,
  type SubmissionPassage,
  SourceError,
  type CompanyFactPassage,
} from '@forkwise/public-data-core';
import {
  selectMaterialContext,
  secMaterialContext,
  type TaskMaterial,
  type MaterialCoverage,
} from './material-context.js';

export interface StructuredModel {
  generate<S extends z.ZodType>(
    schema: S,
    purpose: string,
    data: unknown,
    signal: AbortSignal,
  ): Promise<{ result: z.infer<S>; usage: unknown }>;
}
export interface TaskScope {
  external?: {
    executor: 'external';
    createdBy: string;
    retryOf: string | null;
    serverReads: unknown[];
  };
  update?: UpdateScope;
  workflow?: WorkflowContext;
  trigger?: CorrectionTrigger;
  kind: z.infer<typeof ResearchTaskInput>['kind'];
  materials: TaskMaterial[];
  sourceVersionIds?: string[];
  retrieval?: MaterialCoverage;
  targets: AnyEntity[];
  context: AnyEntity[];
}
const schemas = {
  reconstruct: Reconstruction,
  verify: Verification,
  impact: Impact,
  stance_draft: StanceDraft,
};
const purposes = {
  reconstruct:
    '从给定材料重建可独立研究的主张与推导。origin=author 只能用于材料确有表达且具有精确引用的内容，补充前提或推导标为 ai。每步恰好一个结论。key 仅用于本次输出内部引用；列出缺口。',
  verify:
    '仅用本任务已经取得的材料核对目标。给出支持、相反、限定、背景或证据不足及逐条引用，不把预测或机制当作已证实事实。本任务不提供联网工具，不宣称执行过未提供的搜索。target 使用输入的 contentVersionId。如有 workflow.targets，必须逐项回应：fact 的 aspect 为 reported_fact，prediction 为 current_basis（只核对当前根据，不确认未来结果），inference 为 inference_basis（只核对推导根据，不证明因果）。保留期间、主体和单位差异；原始发言重复不是独立佐证。',
  impact:
    '比较所选新材料与指定目标，提出局部修改建议与依据。如 trigger 为转写校正，只分析指定页面文字变化的影响；新引文须来自 correctedSourceVersionId，未覆盖页面不代表证据消失。保留目标原文和个人判断；输出是候选，不执行修改。target 使用输入的 contentVersionId。',
  stance_draft:
    '针对指定目标起草可供本人考虑的立场理由，区分材料依据、AI 推断与缺口，不代替本人选立场，不补造反证。target 使用输入的 contentVersionId。',
};
export class ResearchTaskService {
  private running = new Map<string, AbortController>();
  private stopping = false;
  constructor(
    readonly write: GraphWriteService,
    readonly jobs: JobRepository,
    readonly model?: StructuredModel,
    readonly search = new SearchRepository(write.repo),
  ) {}
  request(
    projectId: string,
    actor: Actor,
    key: string,
    raw: unknown,
    trigger?: CorrectionTrigger,
    workflow?: WorkflowContext,
    update?: UpdateScope,
    external?: TaskScope['external'],
  ) {
    const input = ResearchTaskInput.parse(raw);
    this.write.repo.project(projectId);
    return this.write.idempotent(
      actor,
      projectId,
      key,
      {
        op: 'research.request',
        input,
        ...(update ? { update } : {}),
        ...(trigger ? { trigger } : {}),
        ...(workflow ? { workflow } : {}),
        ...(external ? { external } : {}),
      },
      () => {
        this.jobs.assertCapacity(projectId);
        const state = this.write.repo.snapshot(projectId);
        const objects = new Map(state.objects.map((e) => [e.id, e]));
        requireThat(
          new Set(input.sourceVersionIds).size === input.sourceVersionIds.length &&
            new Set(input.targetIds).size === input.targetIds.length,
          'DUPLICATE_SCOPE',
          '任务输入不能重复',
        );
        requireThat(
          input.kind === 'reconstruct' || input.targetIds.length > 0,
          'TARGET_REQUIRED',
          '此任务需要明确研究对象',
        );
        const originals = input.sourceVersionIds.map((id) => {
          const version = objects.get(id);
          requireThat(
            version?.kind === 'source_version',
            'MATERIAL_NOT_FOUND',
            '所选材料版本不存在',
            404,
          );
          if (!input.retrieval && secMaterialContext(version)?.history)
            readSecIndex(this.write.repo, projectId, id);
          return { id, version, text: this.write.repo.material(projectId, id) };
        });
        const selected = input.retrieval
          ? selectMaterialContext(projectId, originals, this.search, input.retrieval)
          : undefined;
        const materials: TaskMaterial[] = selected?.materials ?? originals;
        requireThat(
          external || materials.reduce((n, m) => n + m.text.length, 0) <= 1_000_000,
          'TASK_INPUT_TOO_LARGE',
          '本次选择超过模型输入边界，请缩小材料范围；未静默截断',
          413,
        );
        const targets = input.targetIds.map((id) => {
          const e = objects.get(id);
          requireThat(
            e && (e.kind === 'statement' || e.kind === 'inference'),
            'INVALID_TARGET',
            '任务目标必须是本项目主张或推导',
          );
          return e;
        });
        const endpoints = new Set(
          targets.flatMap((e) =>
            e.kind === 'inference' ? [...e.data.premiseIds, e.data.conclusionId] : [],
          ),
        );
        const context = state.objects.filter((e) => endpoints.has(e.id));
        const scope: TaskScope = {
          ...(external ? { external } : {}),
          ...(update ? { update } : {}),
          kind: input.kind,
          materials: external
            ? materials.map((m) => ({
                ...m,
                text: '',
                start: m.start ?? 0,
                end: m.end ?? m.text.length,
              }))
            : materials,
          sourceVersionIds: input.sourceVersionIds,
          ...(selected ? { retrieval: selected.coverage } : {}),
          targets,
          context,
          ...(trigger ? { trigger } : {}),
          ...(workflow ? { workflow } : {}),
        };
        const job = this.jobs.enqueue(
          projectId,
          `research.${input.kind}`,
          scope,
          digest({ kind: input.kind, scope, ...(external ? { key, actorId: actor.id } : {}) }),
        );
        if (workflow && workflowGroup(this.write.repo.db, projectId, workflow.owner))
          linkWorkflowTask(this.write.repo.db, projectId, workflow.owner, job.id);
        return job;
      },
    );
  }
  async run(projectId: string, id: string) {
    const job = this.jobs.claim(projectId, id);
    if (!job) return this.jobs.get(projectId, id);
    const abort = new AbortController();
    this.running.set(id, abort);
    const scope = job.input as TaskScope;
    let usage: unknown = null;
    try {
      requireThat(
        scope.materials.every((m) => typeof m.text === 'string'),
        'MATERIAL_UNAVAILABLE',
        '导入的任务未包含可复核原文，请补齐材料后创建新的任务',
      );
      const originals = new Map<string, string>();
      for (const material of scope.materials) {
        if (!scope.retrieval) {
          const canonical = this.write.repo.version(
            projectId,
            material.id,
            material.version.versionId,
          );
          requireThat(
            canonical,
            'MATERIAL_SCOPE_MISMATCH',
            '全文材料缺少可核对的固定版本，未调用模型',
          );
          if (secMaterialContext(canonical)?.history) {
            requireThat(
              digest(canonical) === digest(material.version),
              'MATERIAL_SCOPE_MISMATCH',
              '全文历史索引的材料版本元数据与保存版本不一致',
            );
            readSecIndex(this.write.repo, projectId, material.id);
          }
        }
        if (!originals.has(material.id))
          originals.set(material.id, this.write.repo.material(projectId, material.id));
        const start = material.start ?? 0,
          end = material.end ?? start + material.text.length;
        requireThat(
          Number.isInteger(start) &&
            Number.isInteger(end) &&
            start >= 0 &&
            end === start + material.text.length &&
            originals.get(material.id)!.slice(start, end) === material.text,
          'MATERIAL_SCOPE_MISMATCH',
          '任务片段与固定材料原文不一致，未调用模型',
        );
      }
      const structuredIds = new Set([
        ...scope.materials.filter((m) => m.structure).map((m) => m.id),
        ...(scope.retrieval?.sources.map((s) => s.sourceVersionId) ?? []),
      ]);
      for (const sourceId of structuredIds) {
        const passages = scope.materials.filter((m) => m.id === sourceId);
        const first = passages[0];
        const canonical = first
          ? this.write.repo.version(projectId, sourceId, first.version.versionId)
          : this.write.repo.history(projectId, sourceId)[0];
        const descriptor = canonical ? secMaterialContext(canonical) : undefined;
        const coverage = scope.retrieval?.sources.find((s) => s.sourceVersionId === sourceId);
        const structured = coverage?.structure || passages.some((p) => p.structure);
        if (!descriptor && !structured) continue;
        requireThat(
          descriptor && (!coverage || coverage.structure?.method === descriptor.method),
          'MATERIAL_SCOPE_MISMATCH',
          '结构化材料缺少匹配的取材标识；请根据原材料新建任务',
        );
        requireThat(
          !first || (canonical && passages.every((m) => digest(m.version) === digest(canonical))),
          'MATERIAL_SCOPE_MISMATCH',
          '结构化片段的材料版本元数据与保存版本不一致',
        );
        try {
          const raw = originals.get(sourceId) ?? this.write.repo.material(projectId, sourceId);
          if (descriptor.method === 'sec_submissions_v1') {
            if (descriptor.history) readSecIndex(this.write.repo, projectId, sourceId);
            const validated = validateSubmissionPassages(
              raw,
              passages as SubmissionPassage[],
              descriptor.cik,
              { history: descriptor.history ?? false },
            );
            requireThat(
              coverage?.structure &&
                digest(coverage.structure.records) === digest(validated.records) &&
                coverage.structure.historyFileCount === validated.historyFileCount,
              'MATERIAL_SCOPE_MISMATCH',
              '申报记录或历史文件覆盖与固定原文不一致',
            );
          } else validateCompanyFactPassages(raw, passages as CompanyFactPassage[], descriptor.cik);
        } catch (error) {
          if (error instanceof SourceError)
            throw new DomainError('MATERIAL_SCOPE_MISMATCH', error.message);
          throw error;
        }
      }
      const noMatches = Boolean(scope.retrieval && !scope.materials.length);
      let generated: { result: unknown; usage: unknown };
      if (noMatches) {
        const gaps = scope.retrieval!.gaps;
        generated = {
          usage: null,
          result:
            scope.kind === 'reconstruct'
              ? { statements: [], inferences: [], gaps }
              : scope.kind === 'verify'
                ? {
                    checks: scope.targets.map((target) => {
                      const planned = scope.workflow?.targets?.find(
                        (t) => t.target.id === target.id,
                      );
                      return {
                        target: { id: target.id, versionId: target.contentVersionId },
                        relation: 'insufficient',
                        explanation:
                          '本次检索未取得可用原文片段；未调用模型，不代表主张错误或全文不存在依据',
                        citations: [],
                        gaps: [],
                        ...(planned ? { aspect: verificationAspect(planned.classification) } : {}),
                      };
                    }),
                    gaps,
                  }
                : { proposals: [], gaps },
        };
      } else {
        requireThat(
          this.model,
          'PROVIDER_NOT_CONFIGURED',
          '尚未配置符合要求的模型，所选材料与个人研究保持原样；可用已授权外部 Agent 提交候选',
          503,
        );
        requireThat(
          JSON.stringify(scope).length <= 1_200_000,
          'TASK_INPUT_TOO_LARGE',
          '任务正文和上下文超过本次模型输入边界，请缩小范围',
          413,
        );
        generated = await this.model.generate(
          schemas[scope.kind],
          purposes[scope.kind] +
            ' materials 中每项可能只是原文片段，start/end 是原始材料的 UTF-16 绝对位置。引用必须落在同一个已提供片段中；不得使用片段内相对位置。未提供的段落并未核查，retrieval 的覆盖和缺口必须保留。structure 为确定性定位的 JSON pointer 与角色，同一 fact 的主体、科目与单位沿父级路径分别提供；必须结合阅读。不同 accn/期间/单位的记录分别保留，不按数组顺序当作最新值，也不把 fy/fp/frame 直接解释成单季或累计。不得自行推断可比性、增长率或补齐缺失口径；关键口径缺失时记录证据不足。sec_submissions_v1 为按列保存的申报索引，同一 recordPointer 的字段属于同一申报，必须合并阅读；它不是申报正文，documentUrl 只是由索引构造的文件入口，当前材料仅代表此文件中的申报记录，未列入本任务材料的其他索引分片均未读取；根索引和历史分片的原文位置不能混用。不得用索引证明营收、利润等正文内容；只能核对目录实际表达的主体和申报元数据，reportDate 不表示完整财务期间，acceptanceDateTime 保留原值但不据此补造历史已知时间。',
          scope,
          abort.signal,
        );
      }
      usage = generated.usage;
      const result = schemas[scope.kind].parse(generated.result);
      this.validateCitations(result, scope);
      if (scope.kind === 'verify' && scope.workflow?.targets) {
        const checks = Verification.parse(result).checks;
        requireThat(
          checks.length === scope.targets.length &&
            new Set(checks.map((c) => c.target.id)).size === checks.length,
          'INCOMPLETE_COVERAGE',
          '首次研究查证必须逐项回应，缺少证据也应明确记录',
        );
        for (const check of checks) {
          const target = scope.workflow.targets.find((t) => t.target.id === check.target.id);
          requireThat(
            target && check.aspect === verificationAspect(target.classification),
            'INVALID_VERIFICATION_ASPECT',
            '查证范围与事实、预测或推导的时间性质不一致',
          );
        }
      }
      this.write.repo.db
        .transaction(() => {
          if (!this.jobs.isRunning(job)) {
            this.jobs.recordDiscardedUsage(job, usage);
            return;
          }
          const current = new Map(
            this.write.repo.snapshot(projectId).objects.map((e) => [e.id, e]),
          );
          const stale = [...scope.targets, ...scope.context].some(
            (e) => current.get(e.id)?.contentVersionId !== e.contentVersionId,
          );
          let changes: unknown = null;
          if (scope.kind === 'reconstruct')
            changes = this.reconstruct(projectId, id, Reconstruction.parse(result));
          if (scope.kind === 'verify' && !stale)
            changes = this.verification(projectId, id, Verification.parse(result), scope);
          this.jobs.finish(
            job,
            'succeeded',
            {
              result,
              changes,
              stale,
              coverage: {
                sourceVersionIds: scope.sourceVersionIds ?? [
                  ...new Set(scope.materials.map((m) => m.id)),
                ],
                networkQueries: [],
                mode: scope.retrieval ? 'retrieved_passages' : 'selected_materials',
                modelCalled: !noMatches,
                ...(scope.retrieval ? { retrieval: scope.retrieval } : {}),
                ...(scope.workflow ? { workflow: scope.workflow } : {}),
              },
              message: stale
                ? '结果对应任务发起时的旧版本，未应用到当前对象'
                : '已生成结果；个人立场与人工条件结论保持',
            },
            null,
            usage,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof DomainError && error.details) usage = error.details;
      if (
        !this.jobs.finish(
          job,
          'failed',
          null,
          error instanceof DomainError
            ? `${error.code}: ${error.message}`
            : '研究任务结果无效或执行失败，材料与个人判断保持',
          usage,
        )
      )
        this.jobs.recordDiscardedUsage(job, usage);
    } finally {
      this.running.delete(id);
    }
    return this.jobs.get(projectId, id);
  }
  validateCitations(result: unknown, scope: TaskScope, projectId?: string) {
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('sourceVersionId' in value && 'quote' in value) {
        const c = TextCitation.parse(value),
          m = scope.materials.find(
            (x) =>
              x.id === c.sourceVersionId &&
              c.start >= (x.start ?? 0) &&
              c.end <= (x.end ?? x.text.length),
          );
        const original =
          m && scope.external && projectId ? this.write.repo.material(projectId, m.id) : undefined;
        if (m && scope.external && projectId)
          requireThat(
            digest(this.write.repo.version(projectId, m.id, m.version.versionId)) ===
              digest(m.version),
            'MATERIAL_SCOPE_MISMATCH',
            '固定材料版本与研究输入不同',
          );
        requireThat(
          m &&
            !c.unavailableReason &&
            c.start < c.end &&
            (original !== undefined
              ? original.slice(c.start, c.end)
              : m.text.slice(c.start - (m.start ?? 0), c.end - (m.start ?? 0))) === c.quote &&
            (!scope.trigger || c.sourceVersionId === scope.trigger.correctedSourceVersionId),
          'INVALID_CITATION',
          '模型引用未命中本次所选材料的原文',
        );
      } else if ('target' in value) {
        const t = (value as { target: { id: string; versionId: string } }).target;
        requireThat(
          scope.targets.some((e) => e.id === t.id && e.contentVersionId === t.versionId),
          'UNBOUND_TARGET',
          '模型引用了任务范围外或错误版本的目标',
        );
        for (const child of Object.values(value)) inspect(child);
      } else for (const child of Object.values(value)) inspect(child);
    };
    inspect(result);
  }
  reconstruct(
    projectId: string,
    jobId: string,
    result: z.infer<typeof Reconstruction>,
    actor: Actor = { id: `job_${jobId}`, type: 'system' },
  ) {
    const id = (key: string) =>
      'candidate_' + createHash('sha256').update(`${jobId}:${key}`).digest('hex');
    const allKeys = [...result.statements, ...result.inferences].map((x) => x.key);
    requireThat(
      new Set(allKeys).size === allKeys.length,
      'DUPLICATE_IDENTITY',
      '模型重复使用对象标识',
    );
    const statementKeys = new Set(result.statements.map((x) => x.key));
    const commands: CommandInput[] = [];
    for (const s of result.statements)
      commands.push({
        op: 'statement.create',
        id: id(s.key),
        data: {
          text: s.text,
          origin: s.origin,
          participation: s.origin === 'author' ? 'reference' : 'candidate',
          stance: { value: 'pending', reason: '' },
          citations: s.citations,
        },
      });
    for (const i of result.inferences) {
      requireThat(
        [...i.premiseKeys, i.conclusionKey].every((k) => statementKeys.has(k)),
        'DANGLING_REFERENCE',
        '模型推导引用了缺失主张',
      );
      commands.push({
        op: 'inference.create',
        id: id(i.key),
        data: {
          premiseIds: i.premiseKeys.map(id),
          conclusionId: id(i.conclusionKey),
          reason: i.reason,
          combination: i.combination,
          origin: i.origin,
          participation: i.origin === 'author' ? 'reference' : 'candidate',
          stance: { value: 'pending', reason: '' },
          citations: i.citations,
        },
      });
    }
    requireThat(
      commands.length <= 100,
      'TOO_MANY_CANDIDATES',
      '本次候选超过原子批次边界，请缩小材料范围后重试',
    );
    return commands.length
      ? this.write.execute(
          projectId,
          actor,
          `candidates_${jobId}`,
          { expected: {}, commands },
          taskWorkflow(this.write.repo.db, projectId, jobId)?.id,
        )
      : null;
  }
  verification(
    projectId: string,
    jobId: string,
    result: z.infer<typeof Verification>,
    scope: TaskScope,
    actor: Actor = { id: `job_${jobId}`, type: 'system' },
  ) {
    const commands: CommandInput[] = [];
    const expected: Record<string, number> = {};
    const current = this.write.repo.snapshot(projectId);
    for (const [i, check] of result.checks.entries()) {
      const target = current.objects.find((e) => e.id === check.target.id)!;
      expected[target.id] = target.version;
      if (target.kind === 'inference')
        for (const id of [...target.data.premiseIds, target.data.conclusionId]) {
          const e = current.objects.find((e) => e.id === id);
          requireThat(e, 'TARGET_REMOVED', '推导前提已移除', 409);
          expected[id] = e.version;
        }

      if (check.relation === 'insufficient') continue;
      requireThat(
        check.citations.length > 0,
        'EVIDENCE_REQUIRED',
        '支持或相反关系必须提供具体引用',
      );
      for (const [j, citation] of check.citations.entries()) {
        const evidenceId = `evidence_${jobId}_${i}_${j}`;
        commands.push(
          { op: 'evidence.create', id: evidenceId, data: { citation } },
          {
            op: 'evidence.link',
            id: `link_${jobId}_${i}_${j}`,
            data: {
              evidenceId,
              target: check.target,
              relation: check.relation,
              explanation: check.explanation,
              origin: 'ai',
              participation: 'candidate',
            },
          },
        );
      }
    }
    requireThat(
      commands.length <= 100,
      'TOO_MANY_CANDIDATES',
      '依据数量超过原子批次边界，请缩小目标范围',
    );
    return commands.length
      ? this.write.execute(
          projectId,
          actor,
          `verification_${jobId}`,
          { expected, commands },
          taskWorkflow(this.write.repo.db, projectId, jobId)?.id,
        )
      : null;
  }
  cancel(projectId: string, id: string) {
    const job = this.jobs.cancel(projectId, id);
    this.running.get(id)?.abort();
    return job;
  }
  abort(id: string) {
    this.running.get(id)?.abort();
  }
  stop() {
    this.stopping = true;
    for (const controller of this.running.values()) controller.abort();
  }
  async drain() {
    const pending = this.write.repo.db
      .prepare(
        "SELECT project_id,id FROM jobs WHERE kind LIKE 'research.%' AND state='queued' AND json_extract(input,'$.external.executor') IS NULL ORDER BY created_at,id",
      )
      .all() as { project_id: string; id: string }[];
    for (const job of pending) {
      if (this.stopping) break;
      await this.run(job.project_id, job.id);
    }
  }
}
