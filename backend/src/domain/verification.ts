import type { AnyEntity, Entity } from '../contracts/entities.js';
import type { CommandInput } from '../contracts/commands.js';
import { digest } from './canonical.js';
import { requireThat } from './errors.js';
import type { WriteContext } from './write-context.js';

export function verificationContext(objects: Map<string, AnyEntity>, target: AnyEntity) {
  const ids =
    target.kind === 'inference'
      ? [...new Set([...target.data.premiseIds, target.data.conclusionId])].sort()
      : [];
  return ids.map((id) => ({ id, versionId: objects.get(id)?.contentVersionId ?? '' }));
}
export function verificationCurrent(
  objects: Map<string, AnyEntity>,
  node: Entity<'verification_node'>,
) {
  const target = objects.get(node.data.target.id);
  return Boolean(
    target &&
      !target.deletedAt &&
      target.contentVersionId === node.data.target.versionId &&
      digest(verificationContext(objects, target)) === digest(node.data.context),
  );
}

export function applyVerification(
  c: WriteContext,
  command: Extract<CommandInput, { op: 'verification.propose' | 'verification.confirm' }>,
) {
  if (command.op === 'verification.confirm') c.human();
  const target = c.readTarget(command.target.id);
  const context = verificationContext(c.objects, target);
  for (const ref of context) c.read(ref.id, 'statement');
  requireThat(
    target.contentVersionId === command.target.versionId &&
      digest(context) === digest(command.context),
    'STALE_VERIFICATION_CONTEXT',
    '内容或前提已变化，请重新核对验证节点；草稿应保留',
    409,
  );
  if (command.op === 'verification.propose') {
    if (command.sourceTask) {
      const job = c.repo.db
        .prepare('SELECT kind FROM jobs WHERE project_id=? AND id=?')
        .get(c.projectId, command.sourceTask) as { kind: string } | undefined;
      requireThat(
        c.actor.type === 'system' && job?.kind === 'workflow.initial',
        'INVALID_SOURCE_TASK',
        '内部来源任务必须由本项目研究编排记录',
      );
    }
    c.add(command.id, 'verification_node', {
      ...command.details,
      target: command.target,
      context,
      status: 'candidate',
      gaps: command.gaps,
      ...(command.sourceTask ? { sourceTask: command.sourceTask } : {}),
    });
    return;
  }
  requireThat(
    command.details.event && command.details.goal,
    'VERIFICATION_DETAILS_REQUIRED',
    '请补明验证事件和到时核对什么；日期未知可留空',
  );
  let basedOn;
  if (command.basedOn) {
    const candidate = c.pinned(command.basedOn);
    requireThat(
      candidate.kind === 'verification_node' &&
        candidate.data.status === 'candidate' &&
        candidate.data.target.id === target.id,
      'INVALID_VERIFICATION_CANDIDATE',
      '候选不属于此研究对象',
    );
    basedOn = command.basedOn;
  }
  const prior = [...c.objects.values()].find(
    (e): e is Entity<'verification_node'> =>
      e.kind === 'verification_node' &&
      !e.deletedAt &&
      e.data.status === 'confirmed' &&
      e.data.target.id === target.id,
  );
  requireThat(
    !prior || prior.id === command.id,
    'VERIFICATION_EXISTS',
    '此对象已有本人节点，请基于当前节点版本修改，不能创建第二份当前确认',
    409,
  );
  basedOn ??= prior?.data.basedOn;
  const data = {
    ...command.details,
    target: command.target,
    context,
    status: 'confirmed' as const,
    gaps: [],
    ...(basedOn ? { basedOn } : {}),
  };
  if (prior) {
    c.expect(prior.id);
    // Repeated confirmation of the same arrangement is a no-op, including when
    // another equivalent AI suggestion has appeared in the meantime.
    const { basedOn: _old, ...before } = prior.data;
    const { basedOn: _new, ...after } = data;
    if (digest(before) === digest(after)) return;
    c.change(prior, data, true);
  } else c.add(command.id, 'verification_node', data);
  c.change(target, { ...target.data, participation: 'personal' }, false);
}
