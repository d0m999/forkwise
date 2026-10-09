import type { AnyEntity } from '../contracts/entities.js';
import { UpdateScope } from '../contracts/manual-updates.js';
import { EntitySchema } from '../contracts/responses.js';
import { z } from 'zod';
import { digest } from '../domain/canonical.js';
import { verificationContext } from '../domain/verification.js';
import { requireThat } from '../domain/errors.js';
import type { ResearchRepository } from '../repositories/research.js';
export const binding = (objects: Map<string, AnyEntity>, target: AnyEntity) => ({
  target: { id: target.id, versionId: target.contentVersionId },
  context: verificationContext(objects, target),
});
export const display = (e: AnyEntity) => ({
  id: e.id,
  kind: e.kind as 'statement' | 'inference',
  text: e.kind === 'statement' ? e.data.text : e.kind === 'inference' ? e.data.reason : '',
  versionId: e.versionId,
});
export const eventIdentity = (sourceId: string, materialHash: string) =>
  digest({ kind: 'manual-update-v1', sourceId, materialHash });
export function validateUpdateScope(
  raw: unknown,
  lookup: (id: string, version: string) => AnyEntity | undefined,
  materialLookup: (id: string) => AnyEntity | undefined,
) {
  const input = z
    .object({
      update: UpdateScope,
      targets: z.array(EntitySchema).max(100),
      context: z.array(EntitySchema).max(10100),
      sourceVersionIds: z.array(z.string()),
      materials: z.array(z.object({ id: z.string(), version: EntitySchema })),
    })
    .parse(raw);
  const tag = input.update,
    material = materialLookup(tag.sourceVersionId);
  requireThat(
    material?.kind === 'source_version' &&
      material.data.sourceId === tag.sourceId &&
      material.data.contentHash === tag.materialHash &&
      tag.eventKey === eventIdentity(tag.sourceId, tag.materialHash),
    'INVALID_UPDATE_SCOPE',
    '更新事件的材料版本或来源身份不一致',
  );
  requireThat(
    input.sourceVersionIds.length === 1 &&
      input.sourceVersionIds[0] === tag.sourceVersionId &&
      input.materials.length === 1 &&
      input.materials.every(
        (m) =>
          m.id === tag.sourceVersionId &&
          m.version.kind === 'source_version' &&
          m.version.data.sourceId === tag.sourceId &&
          m.version.data.contentHash === tag.materialHash &&
          digest(lookup(m.id, m.version.versionId) ?? null) === digest(m.version),
      ),
    'INVALID_UPDATE_SCOPE',
    '更新事件与实际分析材料范围不一致',
  );
  const objects = new Map(input.context.map((e) => [e.id, e]));
  requireThat(
    input.targets.length === tag.bindings.length &&
      new Set(input.targets.map((t) => t.id)).size === input.targets.length,
    'INVALID_UPDATE_SCOPE',
    '更新事件缺少唯一的固定目标',
  );
  const expectedContext = new Set(
    input.targets.flatMap((t) =>
      t.kind === 'inference' ? [...t.data.premiseIds, t.data.conclusionId] : [],
    ),
  );
  requireThat(
    input.context.length === expectedContext.size &&
      new Set(input.context.map((e) => e.id)).size === expectedContext.size &&
      input.context.every((e) => expectedContext.has(e.id)),
    'INVALID_UPDATE_SCOPE',
    '更新上下文必须完整且不能重复或扩展到其他对象',
  );
  const fixedObjects = new Map(
    input.context.map((e) => {
      const value = lookup(e.id, e.versionId);
      requireThat(
        value?.kind === 'statement' && digest(value) === digest(e),
        'INVALID_UPDATE_SCOPE',
        '更新前提版本不存在',
      );
      return [e.id, value] as const;
    }),
  );
  for (const target of input.targets) {
    requireThat(
      target.kind === 'statement' || target.kind === 'inference',
      'INVALID_UPDATE_SCOPE',
      '更新目标类型无效',
    );
    const fixed = lookup(target.id, target.versionId);
    requireThat(
      fixed &&
        digest(fixed) === digest(target) &&
        digest(binding(objects, target)) ===
          digest(tag.bindings.find((b) => b.target.id === target.id)),
      'INVALID_UPDATE_SCOPE',
      '更新目标或前提未绑定固定内容版本',
    );
    requireThat(
      digest(binding(fixedObjects, fixed)) === digest(binding(objects, target)),
      'INVALID_UPDATE_SCOPE',
      '更新事件前提范围与历史不一致',
    );
  }
  return tag;
}
export function eventTasks(repo: ResearchRepository, projectId: string, eventKey: string) {
  const rows = repo.db
    .prepare(
      `SELECT id,state,json_extract(input,'$.update') AS tag,json_extract(input,'$.targets') AS targets,json_extract(input,'$.context') AS context,json_extract(input,'$.sourceVersionIds') AS sources,
    (SELECT json_group_array(json_object('id',json_extract(value,'$.id'),'version',json_extract(value,'$.version'))) FROM json_each(jobs.input,'$.materials')) AS materials
    FROM jobs WHERE project_id=? AND kind='research.impact' AND json_extract(input,'$.update.eventKey')=? ORDER BY created_at,id`,
    )
    .all(projectId, eventKey) as {
    id: string;
    state: string;
    tag: string;
    targets: string;
    context: string;
    sources: string;
    materials: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    scope: validateUpdateScope(
      {
        update: JSON.parse(row.tag),
        targets: JSON.parse(row.targets),
        context: JSON.parse(row.context),
        sourceVersionIds: JSON.parse(row.sources),
        materials: JSON.parse(row.materials),
      },
      (id, version) => repo.version(projectId, id, version),
      (id) => repo.history(projectId, id).find((e) => e.kind === 'source_version' && !e.deletedAt),
    ),
  }));
}
export function downstream(objects: AnyEntity[], targetIds: string[]) {
  const seen = new Set(targetIds),
    queue = [...targetIds];
  const dependents = new Map<string, AnyEntity[]>();
  for (const e of objects)
    if (e.kind === 'inference')
      for (const id of e.data.premiseIds) dependents.set(id, [...(dependents.get(id) ?? []), e]);
  const byId = new Map(objects.map((e) => [e.id, e])),
    found: AnyEntity[] = [];
  while (queue.length) {
    const id = queue.shift()!,
      current = byId.get(id);
    const next =
      current?.kind === 'inference'
        ? [byId.get(current.data.conclusionId)!]
        : (dependents.get(id) ?? []);
    for (const e of next)
      if (e && !seen.has(e.id)) {
        seen.add(e.id);
        queue.push(e.id);
        found.push(e);
      }
  }
  return {
    count: found.length,
    items: found.slice(0, 100).map(display),
    truncated: found.length > 100,
  };
}
