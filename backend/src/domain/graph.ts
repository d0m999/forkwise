import type { AnyEntity, Bodies, Entity, Kind } from '../contracts/entities.js';
import { requireThat } from './errors.js';

export function ofKind<K extends Kind>(
  objects: Map<string, AnyEntity>,
  id: string,
  kind: K,
): Entity<K> {
  const e = objects.get(id);
  requireThat(
    e && !e.deletedAt && e.kind === kind,
    'OBJECT_NOT_FOUND',
    '研究对象不存在或类型不符',
    404,
  );
  return e as Entity<K>;
}
export function related(objects: Map<string, AnyEntity>, id: string): AnyEntity[] {
  return [...objects.values()].filter(
    (e) => !e.deletedAt && references(e).some((r) => r.id === id),
  );
}
export function references(e: AnyEntity): { id: string; role: string }[] {
  switch (e.kind) {
    case 'inference':
      return [
        ...e.data.premiseIds.map((id) => ({ id, role: 'premise' })),
        { id: e.data.conclusionId, role: 'conclusion' },
      ];
    case 'condition':
      return e.data.targetIds.map((id) => ({ id, role: 'condition_target' }));
    case 'evidence':
      return [{ id: e.data.citation.sourceVersionId, role: 'source_version' }];
    case 'evidence_link':
      return [
        { id: e.data.target.id, role: 'evidence_target' },
        { id: e.data.evidenceId, role: 'evidence' },
      ];
    case 'evaluation':
      return [
        { id: e.data.condition.id, role: 'condition' },
        ...e.data.evidenceIds.map((id) => ({ id, role: 'evaluation_evidence' })),
      ];
    case 'verification_node':
      return [{ id: e.data.target.id, role: 'verification_target' }];
    case 'review':
      return [{ id: e.data.target.id, role: 'review_target' }];
    case 'source_version':
      return [
        { id: e.data.sourceId, role: 'source' },
        ...(e.data.provenance?.indexParent
          ? [{ id: e.data.provenance.indexParent.sourceVersionId, role: 'source_index_parent' }]
          : []),
        ...(e.data.derivedFrom ? [{ id: e.data.derivedFrom, role: 'derived_transcription' }] : []),
      ];
    case 'source':
      return e.data.reprintOf ? [{ id: e.data.reprintOf, role: 'reprint' }] : [];
    case 'note':
      return [{ id: e.data.targetId, role: 'note_target' }];
    case 'material_membership':
      return [
        { id: e.data.targetId, role: 'material_target' },
        { id: e.data.sourceVersionId, role: 'material_version' },
      ];
    default:
      return [];
  }
}
export function assertGraph(objects: Map<string, AnyEntity>): void {
  const adjacency = new Map<string, Set<string>>();
  const confirmed = new Set<string>();
  const memberships = new Set<string>();
  const reviews = new Set<string>();
  for (const e of objects.values()) {
    if (e.deletedAt) continue;
    if (e.kind === 'review') {
      const key = JSON.stringify([e.data.jobId, e.data.proposalIndex]);
      const target = objects.get(e.data.target.id);
      requireThat(
        (target?.kind === 'statement' || target?.kind === 'inference') &&
          e.data.proposalTarget.id === target.id,
        'INVALID_REVIEW_TARGET',
        '复核必须对应同一主张或推导',
      );
      requireThat(!reviews.has(key), 'REVIEW_EXISTS', '一条影响建议只能有一份当前复核记录');
      reviews.add(key);
    }
    if (e.kind === 'source_version' && e.data.provenance?.indexParent) {
      const parent = ofKind(
        objects,
        e.data.provenance.indexParent.sourceVersionId,
        'source_version',
      );
      requireThat(
        !parent.data.provenance?.indexParent &&
          parent.data.contentHash === e.data.provenance.indexParent.snapshotHash &&
          Date.parse(parent.createdAt) <= Date.parse(e.createdAt) &&
          Date.parse(parent.data.retrievedAt) <= Date.parse(e.data.retrievedAt),
        'INVALID_INDEX_PARENT',
        '历史索引须绑定根索引的原始版本与指纹',
      );
    }
    for (const ref of references(e)) {
      const target = objects.get(ref.id);
      requireThat(target && !target.deletedAt, 'DANGLING_REFERENCE', '操作会留下悬空引用');
    }
    if (e.kind === 'condition') {
      for (const id of e.data.targetIds) {
        const target = objects.get(id);
        requireThat(
          target?.kind === 'statement' || target?.kind === 'inference',
          'INVALID_TARGET',
          '条件必须关联主张或推导',
        );
      }
    }
    if (e.kind === 'material_membership') {
      const target = objects.get(e.data.targetId),
        key = JSON.stringify([e.data.targetId, e.data.sourceVersionId]);
      requireThat(
        target?.kind === 'statement' || target?.kind === 'inference',
        'INVALID_TARGET',
        '材料列表必须属于主张或推导',
      );
      ofKind(objects, e.data.sourceVersionId, 'source_version');
      requireThat(!memberships.has(key), 'MATERIAL_MEMBERSHIP_EXISTS', '材料列表存在重复关联');
      memberships.add(key);
    }
    if (e.kind === 'verification_node') {
      const target = objects.get(e.data.target.id);
      requireThat(
        target?.kind === 'statement' || target?.kind === 'inference',
        'INVALID_TARGET',
        '验证节点必须关联主张或推导',
      );
      if (e.data.status === 'confirmed') {
        requireThat(
          !confirmed.has(e.data.target.id),
          'VERIFICATION_EXISTS',
          '每个对象仅能有一份当前本人节点',
        );
        confirmed.add(e.data.target.id);
      }
    }
    if (e.kind !== 'inference') continue;
    const { premiseIds, conclusionId, combination } = e.data;
    requireThat(
      new Set(premiseIds).size === premiseIds.length,
      'DUPLICATE_PREMISE',
      '同一步推导不得重复引用同一前提',
    );
    requireThat(
      premiseIds.length < 2 || combination !== 'independent',
      'COMBINATION_REQUIRED',
      '多个前提须明确共同依赖或暂未说明',
    );
    ofKind(objects, conclusionId, 'statement');
    for (const id of premiseIds) {
      ofKind(objects, id, 'statement');
      if (!adjacency.has(id)) adjacency.set(id, new Set());
      adjacency.get(id)!.add(conclusionId);
    }
  }
  // Kahn avoids recursion limits for long chains. Separate reasons may share identical endpoints.
  const degrees = new Map<string, number>();
  for (const [id, to] of adjacency) {
    if (!degrees.has(id)) degrees.set(id, 0);
    for (const target of to) degrees.set(target, (degrees.get(target) ?? 0) + 1);
  }
  const queue = [...degrees].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacency.get(queue[i]!) ?? []) {
      degrees.set(next, degrees.get(next)! - 1);
      if (degrees.get(next) === 0) queue.push(next);
    }
  }
  requireThat(queue.length === degrees.size, 'CYCLE', '推导会形成循环，请用不同时间范围表达反馈');
}
export function clearStance<T extends Bodies['statement'] | Bodies['inference']>(
  body: T,
  actorType: string = 'human',
): T {
  const { editProvenance: _priorEdit, ...rest } = body;
  return {
    ...rest,
    participation: actorType === 'human' ? 'personal' : body.participation,
    stance: { value: 'pending', reason: '' },
  } as T;
}
