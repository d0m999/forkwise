import type Database from 'better-sqlite3';
import type { CompactMaps } from './compact.js';
import { DomainError, requireThat } from '../domain/errors.js';
import type { Change } from './contracts.js';
import {
  ObserveQuerySchema,
  type ObserveQuery,
  type ObservePage,
  type Delta,
} from './observe-contracts.js';

export interface ObserveOptions {
  retentionRevisions?: number;
}

function delta(change: Change): Delta {
  const domains: Delta['domains'] = [], seen = new Set<string>();
  const add = (domain: Delta['domains'][number]['domain'], id: string) => {
    const key = domain + ':' + id;
    if (!seen.has(key)) { seen.add(key); domains.push({ domain, id }); }
  };
  for (const c of change.groupChanges ?? []) add('group', (c.after ?? c.before!).id);
  for (const c of change.containmentChanges ?? []) add('containment', (c.after ?? c.before!).id);
  const objects = [
    ['text', [...(change.textChanges ?? []), ...(change.textChange ? [change.textChange] : [])]],
    ['shape', [...(change.shapeChanges ?? []), ...(change.shapeChange ? [change.shapeChange] : [])]],
    ['stroke', [...(change.strokeChanges ?? []), ...(change.strokeChange ? [change.strokeChange] : [])]],
    ['image', [...(change.imageChanges ?? []), ...(change.imageChange ? [change.imageChange] : [])]],
  ] as const;
  for (const [domain, changes] of objects) for (const c of changes) {
    const value = c.after ?? c.before!;
    if (c.before?.versionId !== c.after?.versionId) add(domain, value.id);
    if (c.before?.item.versionId !== c.after?.item.versionId) add('pose', value.item.id);
  }
  const cards = [...(change.cardLifecycleChanges ?? [])];
  if (change.before && 'body' in change.before || change.after && 'body' in change.after)
    cards.push({ before: change.before && 'body' in change.before ? change.before : null, after: change.after && 'body' in change.after ? change.after : null });
  for (const c of cards) {
    const value = c.after ?? c.before!;
    if (c.before?.versionId !== c.after?.versionId) add('thought', value.id);
    if (c.before?.body.versionId !== c.after?.body.versionId) add('body', value.body.id);
    if (c.before?.item.versionId !== c.after?.item.versionId) add('pose', value.item.id);
    if (c.before?.appearance?.versionId !== c.after?.appearance?.versionId) add('appearance', 'appearance:' + value.id);
    if (c.before?.cardTags?.versionId !== c.after?.cardTags?.versionId) add('cardTags', 'cardTags:' + value.id);
  }
  for (const c of change.cardChanges ?? []) {
    if (c.before.item.versionId !== c.after.item.versionId) add('pose', c.after.item.id);
    if (c.before.cardTags?.versionId !== c.after.cardTags?.versionId) add('cardTags', 'cardTags:' + c.after.id);
  }
  if (change.tagChange) add('tag', change.tagChange.after.id);
  for (const c of change.connectorChanges ?? []) if (c.before?.versionId !== c.after?.versionId) add('connector', (c.after ?? c.before!).id);
  if (!domains.length) add('project', change.projectId);
  const order = new Map(change.changedIds.map((id, index) => [id, index]));
  domains.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { ...change, domains, deletedIds: change.deletedIds ?? [] };
}

// Called inside Mapping's authorized SQLite read transaction. Cache is read-only.
export function observeChanges(
  db: Database.Database,
  compact: CompactMaps,
  input: ObserveQuery,
  options: ObserveOptions = {},
): ObservePage {
  const query = ObserveQuerySchema.parse(input);
  const read = (snapshot?: string) => {
    try {
      return compact.read({
        type: 'map',
        view: 'index',
        projectId: query.projectId,
        snapshot,
        budget: 1_048_576,
      });
    } catch (error) {
      if (
        error instanceof DomainError &&
        ['SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE'].includes(error.code)
      )
        throw new DomainError(error.code, error.message, error.status, {
          recovery: { type: 'map', view: 'index', projectId: query.projectId },
        });
      throw error;
    }
  };
  if (query.baseSnapshot) {
    const base = read(query.baseSnapshot);
    requireThat(
      base.revision === query.afterRevision,
      'INVALID_CURSOR',
      '缓存修订与变化游标不一致',
      409,
    );
    requireThat(!query.snapshot, 'INVALID_CURSOR', '续页不允许重用缓存基线', 409);
  }
  let pinned = read(query.snapshot);
  const current = db
    .prepare('SELECT revision FROM mapping_projects WHERE id=?')
    .get(query.projectId) as { revision: number };
  const retention = options.retentionRevisions ?? 1000;
  requireThat(
    Number.isSafeInteger(retention) && retention > 0,
    'INVALID_CONFIGURATION',
    '变更窗口必须为正整数',
  );
  let reason: ObservePage['reason'];
  if (query.afterRevision > pinned.revision) reason = 'CURSOR_AHEAD';
  else if (query.afterRevision < Math.max(0, current.revision - retention))
    reason = 'CURSOR_TOO_OLD';
  const rows = reason
    ? []
    : (db
        .prepare(
          'SELECT receipt FROM mapping_changes WHERE project_id=? AND revision>? AND revision<=? ORDER BY revision LIMIT ?',
        )
        .all(query.projectId, query.afterRevision, pinned.revision, query.limit + 1) as {
        receipt: string;
      }[]);
  const changes = rows.map((row) => delta(JSON.parse(row.receipt) as Change));
  if (
    !reason &&
    (changes.some((c, i) => c.revision !== query.afterRevision + i + 1) ||
      (changes.length < query.limit + 1 &&
        changes.length !== pinned.revision - query.afterRevision))
  )
    reason = 'CHANGE_GAP';
  if (reason && query.snapshot) pinned = read();
  const make = (count: number): ObservePage => {
    const selected = reason ? [] : changes.slice(0, count);
    const next = reason ? pinned.revision : (selected.at(-1)?.revision ?? query.afterRevision);
    const page: ObservePage = {
      status: reason ? 'RESET_REQUIRED' : 'OK',
      projectId: query.projectId,
      revision: pinned.revision,
      afterRevision: query.afterRevision,
      nextRevision: next,
      complete: next === pinned.revision,
      snapshot: pinned.snapshot,
      expiresAt: pinned.expiresAt,
      budgetUnit: 'utf8_bytes',
      bytes: 0,
      changes: selected,
      ...(reason
        ? {
            reason,
            recovery: {
              type: 'map' as const,
              view: 'index' as const,
              projectId: query.projectId,
              snapshot: pinned.snapshot,
            },
          }
        : {}),
    };
    for (;;) {
      const size = Buffer.byteLength(JSON.stringify(page), 'utf8');
      if (size === page.bytes) return page;
      page.bytes = size;
    }
  };
  let page = make(0);
  const recovery = {
    type: 'map',
    view: 'index',
    projectId: query.projectId,
    snapshot: pinned.snapshot,
  };
  if (page.bytes > query.budget)
    throw new DomainError('BUDGET_TOO_SMALL', '完整变更响应元数据的预算不足', 413, {
      budgetUnit: 'utf8_bytes',
      requiredBytes: page.bytes,
      recovery,
    });
  for (let count = 1; !reason && count <= Math.min(query.limit, changes.length); count++) {
    const candidate = make(count);
    if (candidate.bytes > query.budget) {
      if (count === 1)
        throw new DomainError(
          'ITEM_EXCEEDS_BUDGET',
          '不可拆变化超过预算，请按固定快照完整重读',
          413,
          { budgetUnit: 'utf8_bytes', requiredBytes: candidate.bytes, recovery },
        );
      break;
    }
    page = candidate;
  }
  return page;
}
