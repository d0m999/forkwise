import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ManualUpdateInput,
  ManualUpdateRequest,
  ManualUpdatePreview,
  ManualUpdateResult,
} from '../contracts/manual-updates.js';
import type { Actor } from '../contracts/entities.js';
import { digest } from '../domain/canonical.js';
import { requireThat } from '../domain/errors.js';
import type { ResearchTaskService } from './research-tasks.js';
import { binding, display, eventIdentity, eventTasks, downstream } from './manual-update-scope.js';
export class ManualUpdateService {
  constructor(readonly research: ResearchTaskService) {}
  private prepare(projectId: string, input: z.infer<typeof ManualUpdateInput>) {
    const repo = this.research.write.repo,
      state = repo.snapshot(projectId),
      objects = new Map(state.objects.map((e) => [e.id, e]));
    requireThat(
      new Set(input.targetIds).size === input.targetIds.length,
      'DUPLICATE_SCOPE',
      '更新目标不能重复',
    );
    let material =
      input.material.kind === 'existing' ? objects.get(input.material.sourceVersionId) : undefined;
    requireThat(
      !material || material.kind === 'source_version',
      'MATERIAL_NOT_FOUND',
      '所选材料不存在',
      404,
    );
    if (input.material.kind === 'existing')
      requireThat(material, 'MATERIAL_NOT_FOUND', '所选材料不存在', 404);
    const sourceId =
      input.material.kind === 'text'
        ? input.material.sourceId
        : material!.kind === 'source_version'
          ? material!.data.sourceId
          : '';
    const source = objects.get(sourceId);
    requireThat(
      source?.kind === 'source',
      'SOURCE_NOT_FOUND',
      '请使用本项目已登记且有权使用的来源',
      404,
    );
    const text =
      input.material.kind === 'text' ? input.material.text : repo.material(projectId, material!.id);
    const hash = createHash('sha256').update(text).digest('hex');
    if (input.material.kind === 'text') {
      requireThat(
        Date.parse(input.material.retrievedAt) <= Date.parse(this.research.write.clock()),
        'FUTURE_ACQUISITION',
        '获取时间不能晚于当前时间',
      );
      material = state.objects.find(
        (e) =>
          e.kind === 'source_version' &&
          e.data.sourceId === sourceId &&
          e.data.contentHash === hash,
      );
    }
    requireThat(
      !material ||
        (material.kind === 'source_version' &&
          material.data.parseStatus === 'complete' &&
          material.data.textLength > 0),
      'MATERIAL_INCOMPLETE',
      '材料尚未完整解析，请完成解析或校正后再预览',
    );
    requireThat(
      text.trim().length > 0 && text.length <= 1_000_000,
      'TASK_INPUT_TOO_LARGE',
      '材料须有可读正文且本次最多 100 万字符，未静默截断',
      413,
    );
    const targets = [...input.targetIds].sort().map((id) => {
      const target = objects.get(id);
      requireThat(
        target && (target.kind === 'statement' || target.kind === 'inference'),
        'INVALID_TARGET',
        '更新目标必须是本项目主张或推导',
      );
      return target;
    });
    const bindings = targets.map((t) => binding(objects, t)),
      contextIds = new Set(bindings.flatMap((b) => b.context.map((c) => c.id)));
    const context = [...contextIds].sort().map((id) => objects.get(id)!);
    requireThat(
      JSON.stringify({ targets, context, text }).length <= 1_100_000,
      'TASK_INPUT_TOO_LARGE',
      '材料和论证上下文超过本次输入边界，请缩小范围',
      413,
    );
    const eventKey = eventIdentity(sourceId, hash),
      prior = eventTasks(repo, projectId, eventKey);
    const eligible = prior.filter((j) => j.state !== 'cancelled');
    const covered = new Set(eligible.flatMap((j) => j.scope.bindings.map((b) => digest(b))));
    const newTargetIds = bindings.filter((b) => !covered.has(digest(b))).map((b) => b.target.id);
    const existingJobIds = eligible
      .filter((j) => j.scope.bindings.some((b) => bindings.some((w) => digest(w) === digest(b))))
      .map((j) => j.id);
    const newMaterial = !material,
      coverage =
        material?.kind === 'source_version'
          ? (material.data.coverage ?? 'unknown')
          : input.material.kind === 'text'
            ? input.material.coverage
            : 'unknown';
    const previewHash = digest({
      input,
      sourceVersion: source.versionId,
      material: material?.versionId ?? null,
      targets: targets.map((t) => t.versionId),
      context: context.map((t) => t.versionId),
      existingJobIds,
      newTargetIds,
    });
    const preview = ManualUpdatePreview.parse({
      projectId,
      eventKey,
      previewHash,
      scopeLabel: input.scopeLabel,
      sourceId,
      sourceTitle: source.data.title,
      sourceVersionId: material?.id ?? null,
      newMaterial,
      publishedAt:
        material?.kind === 'source_version'
          ? material.data.publishedAt
          : input.material.kind === 'text'
            ? input.material.publishedAt
            : null,
      retrievedAt:
        material?.kind === 'source_version'
          ? material.data.retrievedAt
          : input.material.kind === 'text'
            ? input.material.retrievedAt
            : '',
      materialHash: hash,
      coverage,
      targets: targets.map(display),
      context: context.map(display),
      newTargetIds,
      existingJobIds,
      downstream: downstream(state.objects, input.targetIds),
      estimate: {
        materialCharacters: text.length,
        targetContextCharacters: JSON.stringify({ targets, context }).length,
        newTaskCount: newTargetIds.length ? 1 : 0,
        estimatedCost: null,
        costStatus: 'unknown',
      },
      gaps: [
        ...(coverage === 'full' ? [] : ['材料覆盖为片段或未知，未提供部分不会被核对']),
        '金额与 Token 用量尚不可准确预估，实际用量在任务中记录；本次不会联网取得其他材料。',
      ],
    });
    return { preview, source, material, bindings, prior };
  }
  preview(projectId: string, raw: unknown) {
    const input = ManualUpdateInput.parse(raw);
    return this.research.write.repo.db
      .transaction(() => this.prepare(projectId, input).preview)
      .deferred();
  }
  request(
    projectId: string,
    actor: Actor,
    key: string,
    raw: unknown,
  ): z.infer<typeof ManualUpdateResult> {
    const request = ManualUpdateRequest.parse(raw),
      { previewHash, ...input } = request,
      write = this.research.write;
    write.repo.project(projectId);
    return write.idempotent(actor, projectId, key, { op: 'manual-update.request', request }, () => {
      const prepared = this.prepare(projectId, input),
        p = prepared.preview;
      requireThat(
        previewHash === p.previewHash,
        'UPDATE_PREVIEW_CONFLICT',
        '材料、目标或更新覆盖已变化，请保留草稿并重新预览',
        409,
      );
      const revision = write.repo.project(projectId).revision;
      let sourceVersionId = p.sourceVersionId ?? randomUUID();
      let changes = {
        projectId,
        revisionBefore: revision,
        revisionAfter: revision,
        upserted: [],
        deletedIds: [],
      } as z.infer<typeof ManualUpdateResult>['changes'];
      if (p.newMaterial && input.material.kind === 'text') {
        changes = write.execute(projectId, actor, `update-material_${digest(key + actor.id)}`, {
          expected: { [prepared.source.id]: prepared.source.version },
          commands: [
            {
              op: 'source.import',
              id: sourceVersionId,
              sourceId: input.material.sourceId,
              text: input.material.text,
              retrievedAt: input.material.retrievedAt,
              publishedAt: input.material.publishedAt,
              coverage: input.material.coverage,
            },
          ],
        });
      }
      let createdJobId: string | null = null;
      if (p.newTargetIds.length) {
        const update = {
          schemaVersion: 1 as const,
          cancelledFingerprint: digest(
            prepared.prior
              .filter((j) => j.state === 'cancelled')
              .map((j) => j.id)
              .sort(),
          ),
          cancelledJobIds: prepared.prior
            .filter((j) => j.state === 'cancelled')
            .slice(-1)
            .map((j) => j.id),
          eventKey: p.eventKey,
          sourceId: p.sourceId,
          sourceVersionId,
          materialHash: p.materialHash,
          scopeLabel: input.scopeLabel,
          bindings: prepared.bindings.filter((b) => p.newTargetIds.includes(b.target.id)),
        };
        const job = this.research.request(
          projectId,
          actor,
          `update-task_${digest(key + actor.id)}`,
          { kind: 'impact', sourceVersionIds: [sourceVersionId], targetIds: p.newTargetIds },
          undefined,
          undefined,
          update,
        );
        createdJobId = job.id;
      }
      return ManualUpdateResult.parse({
        eventKey: p.eventKey,
        sourceVersionId,
        createdJobId,
        existingJobIds: p.existingJobIds,
        changes,
        message: createdJobId
          ? '材料已保存，已为新增范围排队；个人判断保持。'
          : '同一材料版本与论证范围已有任务，未重复生成候选；可查看或重试原任务。',
      });
    });
  }
}
