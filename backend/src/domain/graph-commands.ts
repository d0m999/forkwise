import { randomUUID } from 'node:crypto';
import type { CommandInput } from '../contracts/commands.js';
import { clearStance, related } from './graph.js';
import { requireThat } from './errors.js';
import type { WriteContext } from './write-context.js';
import { readImpactProposal } from './impact-review.js';
import { verificationContext } from './verification.js';
import { digest } from './canonical.js';

export function applyGraph(c: WriteContext, command: CommandInput): boolean {
  switch (command.op) {
    case 'impact.adopt': {
      c.human();
      const e = c.readTarget(command.id);
      requireThat(
        c.original.get(e.id)?.versionId === e.versionId,
        'PROPOSAL_TARGET_CHANGED',
        '同一批次采用建议前不能先改写目标，避免丢失采用前版本',
      );
      const candidate = readImpactProposal(
        c.repo,
        c.projectId,
        command.jobId,
        command.proposalIndex,
      );
      const proposal = candidate.proposal;
      requireThat(
        !candidate.stale &&
          proposal.target.id === e.id &&
          proposal.target.versionId === e.contentVersionId &&
          digest(verificationContext(c.objects, e)) === digest(candidate.context),
        'STALE_PROPOSAL',
        '修改建议属于旧内容版本或前提版本，请重新分析后审阅',
        409,
      );
      for (const citation of proposal.citations) c.citation(citation);
      requireThat(
        command.scope === 'selected'
          ? e.kind === 'statement' && !!command.newId && command.inferenceIds.length > 0
          : !command.newId && !command.inferenceIds.length,
        'INVALID_SCOPE',
        '局部采用须指定新主张和下游推导；全部采用不能带局部范围',
      );
      if (e.kind === 'statement') {
        applyGraph(
          c,
          command.scope === 'all'
            ? { op: 'statement.edit', id: e.id, text: command.text, scope: 'all' }
            : {
                op: 'statement.derive',
                id: e.id,
                newId: command.newId!,
                text: command.text,
                inferenceIds: command.inferenceIds,
              },
        );
      } else
        applyGraph(c, {
          op: 'inference.edit',
          id: e.id,
          premiseIds: e.data.premiseIds,
          conclusionId: e.data.conclusionId,
          combination: e.data.combination,
          reason: command.text,
        });
      const changed = c.readTarget(command.scope === 'selected' ? command.newId! : e.id);
      c.change(
        changed,
        {
          ...clearStance(changed.data, c.actor.type),
          citations: proposal.citations,
          editProvenance: {
            jobId: command.jobId,
            proposalIndex: command.proposalIndex,
            previous: { id: e.id, versionId: e.versionId },
            scope: command.scope,
            modified: command.text !== proposal.proposedText,
          },
        },
        true,
      );
      return true;
    }
    case 'statement.create':
      c.attribution(command.data);
      requireThat(!command.data.lineage, 'USE_DERIVE', '改写来历必须由派生操作生成');
      c.add(command.id, 'statement', command.data);
      return true;
    case 'inference.create':
      c.attribution(command.data);
      for (const id of [...command.data.premiseIds, command.data.conclusionId])
        c.read(id, 'statement');
      c.add(command.id, 'inference', command.data);
      return true;
    case 'statement.copy': {
      const e = c.read(command.id, 'statement');
      c.add(
        command.newId,
        'statement',
        clearStance(
          {
            ...e.data,
            participation: c.actor.type === 'human' ? 'personal' : 'candidate',
            lineage: { id: e.id, versionId: e.versionId },
          },
          c.actor.type,
        ),
      );
      for (const member of [...c.objects.values()]) {
        if (
          !member.deletedAt &&
          member.kind === 'material_membership' &&
          member.data.targetId === e.id &&
          member.data.visibility === 'included'
        ) {
          c.read(member.id, 'material_membership');
          c.add(randomUUID(), 'material_membership', { ...member.data, targetId: command.newId });
        }
      }
      return true;
    }
    case 'statement.edit': {
      const e = c.read(command.id, 'statement');
      if (e.data.text === command.text) return true;
      for (const ref of related(c.objects, e.id)) if (ref.kind === 'inference') c.expect(ref.id);
      c.change(e, clearStance({ ...e.data, text: command.text }, c.actor.type), true);
      return true;
    }
    case 'statement.derive': {
      const e = c.read(command.id, 'statement');
      requireThat(
        new Set(command.inferenceIds).size === command.inferenceIds.length,
        'DUPLICATE_REFERENCE',
        '选定推导不能重复',
      );
      const selected = command.inferenceIds.map((id) => c.read(id, 'inference'));
      requireThat(
        selected.every((i) => i.data.premiseIds.includes(e.id)),
        'INVALID_SCOPE',
        '局部派生只能改接明确选中的下游推导',
      );
      c.add(
        command.newId,
        'statement',
        clearStance(
          {
            ...e.data,
            text: command.text,
            citations: [],
            lineage: { id: e.id, versionId: e.versionId },
          },
          c.actor.type,
        ),
      );
      for (const i of selected)
        c.change(
          i,
          clearStance(
            {
              ...i.data,
              premiseIds: i.data.premiseIds.map((id) => (id === e.id ? command.newId : id)),
            },
            c.actor.type,
          ),
          true,
        );
      return true;
    }
    case 'inference.edit': {
      const e = c.read(command.id, 'inference');
      for (const id of [
        ...e.data.premiseIds,
        e.data.conclusionId,
        ...command.premiseIds,
        command.conclusionId,
      ])
        c.read(id, 'statement');
      const data = {
        ...e.data,
        premiseIds: command.premiseIds,
        conclusionId: command.conclusionId,
        reason: command.reason,
        combination: command.combination,
      };
      if (JSON.stringify(data) !== JSON.stringify(e.data))
        c.change(e, clearStance(data, c.actor.type), true);
      return true;
    }
    case 'stance.set': {
      c.human();
      const e = c.get(command.id);
      c.expect(e.id);
      requireThat(
        e.kind === 'statement' || e.kind === 'inference',
        'INVALID_TARGET',
        '只能对陈述或推导记录个人立场',
      );
      if (command.stance.reasonProvenance) {
        const p = command.stance.reasonProvenance;
        const row = c.repo.db
          .prepare(
            "SELECT output FROM jobs WHERE project_id=? AND id=? AND kind='research.stance_draft' AND state='succeeded'",
          )
          .get(c.projectId, p.jobId) as { output: string } | undefined;
        requireThat(row, 'DRAFT_NOT_FOUND', 'AI 理由草稿不属于当前项目或尚未完成');
        const proposal = JSON.parse(row.output).result?.proposals?.[p.proposalIndex];
        requireThat(
          proposal?.target.id === e.id && proposal?.target.versionId === e.contentVersionId,
          'STALE_DRAFT',
          'AI 理由不属于当前内容版本',
          409,
        );
        requireThat(
          p.modified || proposal.reason === command.stance.reason,
          'DRAFT_MODIFIED',
          '使用已修改理由时须保留修改标记',
        );
      }
      c.change(e, { ...e.data, stance: command.stance, participation: 'personal' }, false);
      return true;
    }
    case 'object.adopt': {
      c.human();
      const e = c.get(command.id);
      c.expect(e.id);
      requireThat(
        e.kind === 'statement' || e.kind === 'inference',
        'INVALID_TARGET',
        '只能采用陈述或推导',
      );
      c.change(e, { ...e.data, participation: 'personal' }, false);
      return true;
    }
    case 'note.create': {
      c.human();
      c.expect(command.targetId);
      c.get(command.targetId);
      c.add(command.id, 'note', { targetId: command.targetId, text: command.text });
      return true;
    }
    case 'object.delete': {
      const e = c.get(command.id);
      c.expect(e.id);
      requireThat(
        ![
          'source',
          'source_version',
          'evaluation',
          'evidence',
          'verification_node',
          'review',
          'material_membership',
        ].includes(e.kind),
        'IMMUTABLE_OBJECT',
        '材料、证据与评估作为历史保留；请使用项目删除或追加更正流程',
      );
      const queue = [e];
      const seen = new Set<string>();
      for (const item of queue) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        c.expect(item.id);
        for (const incoming of related(c.objects, item.id)) {
          c.expect(incoming.id);
          if (incoming.kind === 'condition')
            c.change(
              incoming,
              {
                ...incoming.data,
                targetIds: incoming.data.targetIds.filter((id) => id !== item.id),
              },
              false,
            );
          else queue.push(incoming);
        }
        c.remove(item);
      }
      return true;
    }
    default:
      return false;
  }
}
