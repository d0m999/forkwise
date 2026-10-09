import { createHash } from 'node:crypto';
import type { CommandInput } from '../contracts/commands.js';
import { requireThat } from './errors.js';
import type { WriteContext } from './write-context.js';
import { digest } from './canonical.js';
import { verificationContext, applyVerification } from './verification.js';
import { applyReview } from './impact-review.js';

export function applyResearch(c: WriteContext, command: CommandInput): void {
  switch (command.op) {
    case 'impact.review':
      applyReview(c, command);
      break;
    case 'material.attach': {
      c.human();
      const target = c.readTarget(command.targetId);
      c.read(command.sourceVersionId, 'source_version');
      const existing = [...c.objects.values()].find(
        (e) =>
          !e.deletedAt &&
          e.kind === 'material_membership' &&
          e.data.targetId === target.id &&
          e.data.sourceVersionId === command.sourceVersionId,
      );
      if (existing) {
        requireThat(
          existing.id === command.id,
          'MATERIAL_MEMBERSHIP_EXISTS',
          '此对象已关联该材料版本，请复用已有材料关联',
          409,
        );
        c.read(existing.id, 'material_membership');
        if (existing.kind === 'material_membership')
          c.change(existing, { ...existing.data, visibility: 'included' }, false);
      } else
        c.add(command.id, 'material_membership', {
          targetId: target.id,
          sourceVersionId: command.sourceVersionId,
          visibility: 'included',
        });
      if (target.data.participation !== 'personal')
        c.change(target, { ...target.data, participation: 'personal' }, false);
      break;
    }
    case 'material.hide': {
      c.human();
      const membership = c.read(command.id, 'material_membership');
      c.readTarget(membership.data.targetId);
      c.change(membership, { ...membership.data, visibility: 'excluded' }, false);
      break;
    }
    case 'verification.propose':
    case 'verification.confirm':
      applyVerification(c, command);
      break;
    case 'condition.create':
      for (const id of command.data.targetIds) c.readTarget(id);
      requireThat(!command.data.lineage, 'USE_DERIVE', '来历须由派生操作生成');
      c.add(command.id, 'condition', command.data);
      break;
    case 'condition.edit': {
      const e = c.read(command.id, 'condition');
      for (const id of new Set([...e.data.targetIds, ...command.data.targetIds])) c.readTarget(id);
      requireThat(
        JSON.stringify(e.data.lineage) === JSON.stringify(command.data.lineage),
        'IMMUTABLE_LINEAGE',
        '改写来历不可覆盖',
      );
      const content =
        e.data.description !== command.data.description ||
        e.data.mode !== command.data.mode ||
        JSON.stringify(e.data.rule) !== JSON.stringify(command.data.rule);
      c.change(e, command.data, content);
      break;
    }
    case 'condition.derive': {
      const e = c.read(command.id, 'condition');
      requireThat(
        new Set(command.targetIds).size === command.targetIds.length &&
          command.targetIds.length === command.data.targetIds.length &&
          command.targetIds.every((id) => command.data.targetIds.includes(id)),
        'INVALID_SCOPE',
        '派生范围与新条件引用必须一致且不可重复',
      );
      requireThat(!command.data.lineage, 'IMMUTABLE_LINEAGE', '来历须由派生操作生成');
      requireThat(
        command.targetIds.every((id) => e.data.targetIds.includes(id)),
        'INVALID_SCOPE',
        '选定引用不属于原条件',
      );
      for (const id of command.targetIds) c.readTarget(id);
      c.change(
        e,
        { ...e.data, targetIds: e.data.targetIds.filter((id) => !command.targetIds.includes(id)) },
        false,
      );
      c.add(command.newId, 'condition', {
        ...command.data,
        targetIds: command.targetIds,
        lineage: { id: e.id, versionId: e.versionId },
      });
      break;
    }
    case 'source.create':
      if (command.data.reprintOf) c.read(command.data.reprintOf, 'source');
      c.add(command.id, 'source', command.data);
      break;
    case 'source.import': {
      c.read(command.sourceId, 'source');
      requireThat(
        Date.parse(command.retrievedAt) <= Date.parse(c.now),
        'FUTURE_ACQUISITION',
        '获取时间不能晚于当前时间',
      );
      const contentHash = createHash('sha256').update(command.text).digest('hex');
      const duplicate = [...c.objects.values()].find(
        (e) =>
          e.kind === 'source_version' &&
          !e.deletedAt &&
          e.data.sourceId === command.sourceId &&
          e.data.contentHash === contentHash,
      );
      requireThat(
        !duplicate,
        'SOURCE_VERSION_EXISTS',
        '同一来源已保存相同内容，请复用已有材料版本',
        409,
      );
      c.add(command.id, 'source_version', {
        sourceId: command.sourceId,
        contentHash,
        textLength: command.text.length,
        retrievedAt: new Date(command.retrievedAt).toISOString(),
        publishedAt: command.publishedAt ? new Date(command.publishedAt).toISOString() : null,
        ...(command.businessPeriod ? { businessPeriod: command.businessPeriod } : {}),
        ...(command.provenance ? { provenance: command.provenance } : {}),
        ...(command.coverage ? { coverage: command.coverage } : {}),
        parseStatus: 'complete',
        parseMessage: '',
      });
      c.texts.set(command.id, command.text);
      break;
    }
    case 'source.parse': {
      requireThat(
        c.actor.type === 'system' ||
          (c.actor.type === 'human' &&
            command.textOrigin === 'human_correction' &&
            Boolean(command.derivedFrom)),
        'SYSTEM_REQUIRED',
        '解析产物必须由受控材料任务提交',
        403,
      );
      c.read(command.sourceId, 'source');
      const file = c.repo.db
        .prepare(
          'SELECT source_id,retrieved_at,published_at FROM file_assets WHERE project_id=? AND id=?',
        )
        .get(c.projectId, command.fileId) as
        | { source_id: string; retrieved_at: string; published_at: string | null }
        | undefined;
      requireThat(
        file?.source_id === command.sourceId,
        'FILE_NOT_FOUND',
        '原文件不属于指定来源和项目',
        404,
      );
      if (command.derivedFrom) {
        const original = c.read(command.derivedFrom, 'source_version');
        requireThat(
          original.data.fileId === command.fileId,
          'INVALID_CORRECTION',
          '转写校正不能替换原文件',
        );
      }
      requireThat(
        command.status !== 'complete' || command.text.trim().length > 0,
        'EMPTY_PARSE',
        '空文本不能报告完整读取',
      );
      c.add(command.id, 'source_version', {
        sourceId: command.sourceId,
        fileId: command.fileId,
        contentHash: createHash('sha256').update(command.text).digest('hex'),
        textLength: command.text.length,
        retrievedAt: file.retrieved_at,
        publishedAt: file.published_at,
        normalizerVersion: command.normalizerVersion,
        textOrigin: command.textOrigin,
        ...(command.provenance ? { provenance: command.provenance } : {}),
        parseStatus: command.status,
        parseMessage: command.message,
        ...(command.derivedFrom ? { derivedFrom: command.derivedFrom } : {}),
      });
      c.texts.set(command.id, command.text);
      break;
    }
    case 'evidence.create':
      c.citation(command.data.citation);
      c.add(command.id, 'evidence', command.data);
      break;
    case 'evidence.link': {
      if (c.actor.type !== 'human')
        requireThat(
          command.data.origin === 'ai' && command.data.participation === 'candidate',
          'HUMAN_REQUIRED',
          'Agent 关联须保留 AI 候选，不能代替本人采用',
          403,
        );
      c.read(command.data.evidenceId, 'evidence');
      const target = c.readTarget(command.data.target.id);
      requireThat(
        target.contentVersionId === command.data.target.versionId,
        'STALE_TARGET',
        '证据关联必须明确针对当前内容版本',
        409,
      );
      const context = verificationContext(c.objects, target);
      for (const ref of context) c.read(ref.id, 'statement');
      requireThat(
        !command.data.context || digest(context) === digest(command.data.context),
        'STALE_TARGET',
        '推导前提已改变，请重新核对',
        409,
      );
      c.add(command.id, 'evidence_link', { ...command.data, context });
      break;
    }
    case 'evidence.relate':
    case 'evidence.adopt': {
      c.human();
      const link = c.read(command.id, 'evidence_link'),
        target = c.readTarget(link.data.target.id);
      requireThat(
        target.contentVersionId === link.data.target.versionId,
        'STALE_TARGET',
        '旧内容版本的依据需要重新核对，不能直接关联为当前依据',
        409,
      );
      const context = verificationContext(c.objects, target);
      for (const ref of context) c.read(ref.id, 'statement');
      requireThat(
        digest(context) === digest(link.data.context ?? []),
        'STALE_TARGET',
        '证据关联的推导前提已变化，需要重新核对后重新关联',
        409,
      );
      c.change(
        link,
        command.op === 'evidence.adopt'
          ? { ...link.data, participation: 'adopted' }
          : { ...link.data, relation: command.relation, explanation: command.explanation },
        false,
      );
      break;
    }
    case 'evaluation.propose':
    case 'evaluation.confirm': {
      const condition = c.read(command.condition.id, 'condition');
      requireThat(
        condition.contentVersionId === command.condition.versionId,
        'STALE_RULE',
        '规则已改变，请基于当前规则重新评估',
        409,
      );
      if (command.op === 'evaluation.confirm') c.human();
      for (const id of command.evidenceIds) c.read(id, 'evidence');
      for (const citation of command.citations) c.citation(citation);
      let basedOn;
      if (command.op === 'evaluation.confirm' && command.evaluationId) {
        const previous = c.read(command.evaluationId, 'evaluation');
        requireThat(
          previous.data.condition.id === condition.id &&
            previous.data.condition.versionId === condition.contentVersionId,
          'STALE_EVALUATION',
          '所确认评估不属于当前规则',
          409,
        );
        basedOn = { id: previous.id, versionId: previous.versionId };
        requireThat(
          command.verdict === previous.data.verdict || command.reason !== previous.data.reason,
          'PERSONAL_REASON_REQUIRED',
          '调整或否决候选结论时，请补充本人理由',
        );
      }
      c.add(command.id, 'evaluation', {
        condition: command.condition,
        evaluator: command.op === 'evaluation.confirm' ? 'human' : 'ai',
        verdict: command.verdict,
        reason: command.reason,
        evidenceIds: command.evidenceIds,
        citations: command.citations,
        missing: command.op === 'evaluation.propose' ? command.missing : [],
        evaluatedAt: c.now,
        tentative: command.op === 'evaluation.propose' && command.tentative,
        ...(basedOn ? { basedOn } : {}),
      });
      break;
    }
    default:
      requireThat(false, 'UNSUPPORTED_OPERATION', '不支持此业务操作');
  }
}
