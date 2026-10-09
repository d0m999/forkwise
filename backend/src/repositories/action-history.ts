import { assertWorkflowWritable } from './workflow-history.js';
import { randomUUID } from 'node:crypto';
import { ActionJournal, type ActionHistoryStatus } from '../contracts/action-history.js';
import type { Actor, AnyEntity } from '../contracts/entities.js';
import type { Layout } from '../contracts/layout.js';
import type { ResearchRepository } from './research.js';
import { canonical } from '../domain/canonical.js';
import { requireThat } from '../domain/errors.js';
import { assertGraph } from '../domain/graph.js';

export function readJournal(repo: ResearchRepository, projectId: string): ActionJournal {
  repo.project(projectId);
  const row = repo.db
    .prepare('SELECT data FROM action_history WHERE project_id=?')
    .get(projectId) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : { version: 0, cursor: 0, entries: [] };
}
export function saveJournal(repo: ResearchRepository, projectId: string, journal: ActionJournal) {
  repo.db
    .prepare(
      'INSERT INTO action_history(project_id,data) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data',
    )
    .run(projectId, JSON.stringify(journal));
}
export function historyStatus(j: ActionJournal): ActionHistoryStatus {
  const brief = (i: number) => {
    const e = j.entries[i];
    return e ? { id: e.id, label: e.label } : null;
  };
  return { version: j.version, undo: brief(j.cursor - 1), redo: brief(j.cursor) };
}
/** Presentation content only. Navigation, selection and unsaved forms are never undone. */
export function historyLayout(data: Layout['data']): Layout['data'] {
  return {
    positions: data.positions,
    drawings: data.drawings,
    ...(Object.keys(data.ports ?? {}).length ? { ports: data.ports } : {}),
    ...(data.canvas
      ? {
          canvas: {
            scenes: Object.fromEntries(
              Object.entries(data.canvas.scenes).flatMap(([id, s]) =>
                Object.keys(s.styles).length || Object.keys(s.frames ?? {}).length
                  ? [
                      [
                        id,
                        {
                          styles: s.styles,
                          ...(Object.keys(s.frames ?? {}).length ? { frames: s.frames } : {}),
                        },
                      ],
                    ]
                  : [],
              ),
            ),
            annotations: data.canvas.annotations,
            ...(Object.keys(data.canvas.attachments ?? {}).length
              ? { attachments: data.canvas.attachments }
              : {}),
          },
        }
      : {}),
  };
}
export function restoreHistoryLayout(
  saved: Layout['data'],
  current: Layout['data'],
): Layout['data'] {
  const data = structuredClone(saved);
  if (current.canvas) {
    data.canvas ??= { scenes: {}, annotations: { elements: [], files: {} } };
    for (const [id, scene] of Object.entries(current.canvas.scenes))
      if (scene.view)
        (data.canvas.scenes[id] ??= { styles: {} }).view = structuredClone(scene.view);
    if (current.canvas.drafts) data.canvas.drafts = structuredClone(current.canvas.drafts);
    if (current.canvas.returnViews)
      data.canvas.returnViews = structuredClone(current.canvas.returnViews);
  }
  return data;
}
export function recordAction(
  repo: ResearchRepository,
  projectId: string,
  actor: Actor,
  now: string,
  before: Map<string, AnyEntity>,
  changed: AnyEntity[],
  oldLayout: Layout,
  nextLayout: Layout,
  label: string,
  workflowId?: string,
) {
  const objects = changed
    .filter((e) => e.kind !== 'source' && e.kind !== 'source_version')
    .map((e) => ({
      id: e.id,
      before: before.get(e.id)?.versionId ?? null,
      after: e.versionId,
    }));
  const prior = historyLayout(oldLayout.data),
    after = historyLayout(nextLayout.data);
  // An empty canvas container is equivalent to the pre-initialization layout.
  const meaningful = (v: Layout['data']) => {
    const d = structuredClone(v);
    if (
      d.canvas &&
      !Object.keys(d.canvas.scenes).length &&
      !d.canvas.annotations.elements.length &&
      !Object.keys(d.canvas.annotations.files).length &&
      !Object.keys(d.canvas.attachments ?? {}).length
    )
      delete d.canvas;
    return canonical(d);
  };
  const layoutChanged = meaningful(prior) !== meaningful(after);
  if (!objects.length && !layoutChanged) return;
  const j = readJournal(repo, projectId);
  if (workflowId) {
    assertWorkflowWritable(repo.db, projectId, workflowId);
    requireThat(
      objects.every((e) => e.before === null) && !layoutChanged,
      'INVALID_WORKFLOW_WRITE',
      '异步研究分组只能追加新的候选对象，不能合并个人编辑或布局',
    );
    const index = j.entries.findIndex((e) => e.workflowId === workflowId);
    requireThat(
      index < 0 || index < j.cursor,
      'WORKFLOW_WITHDRAWN',
      '此研究已撤销，不应用晚到结果',
      409,
    );
    j.entries = j.entries.slice(0, j.cursor);
    if (index >= 0) j.entries[index]!.objects.push(...objects);
    // A group older than the retained 40 steps remains outside the undo window.
    j.version++;
    saveJournal(repo, projectId, j);
    return;
  }
  j.entries = [
    ...j.entries.slice(0, j.cursor),
    {
      id: randomUUID(),
      label,
      at: now,
      actor,
      objects,
      ...(layoutChanged ? { layout: { before: prior, after } } : {}),
    },
  ].slice(-40);
  j.cursor = j.entries.length;
  j.version++;
  saveJournal(repo, projectId, j);
}
export function sameHistoricalState(
  current: AnyEntity | undefined,
  saved: AnyEntity | null,
): boolean {
  if (!saved || saved.deletedAt) return !current || Boolean(current.deletedAt);
  return (
    !!current &&
    !current.deletedAt &&
    current.kind === saved.kind &&
    current.contentVersionId === saved.contentVersionId &&
    canonical(current.data) === canonical(saved.data)
  );
}
/** Restores trusted immutable versions, never client-supplied replacement objects. */
export function applyHistoryEntry(
  objects: Map<string, AnyEntity>,
  j: ActionJournal,
  direction: 'undo' | 'redo',
  lookup: (id: string, version: string) => AnyEntity | undefined,
): Map<string, AnyEntity> {
  const entry = j.entries[direction === 'undo' ? j.cursor - 1 : j.cursor];
  requireThat(
    entry,
    'HISTORY_EMPTY',
    direction === 'undo' ? '没有可撤销的操作' : '没有可重做的操作',
    409,
  );
  const next = new Map(objects);
  for (const ref of entry.objects) {
    const from = direction === 'undo' ? ref.after : ref.before,
      to = direction === 'undo' ? ref.before : ref.after;
    const read = (v: string | null) => {
      if (v === null) return null;
      const e = lookup(ref.id, v);
      requireThat(
        e &&
          e.id === ref.id &&
          e.versionId === v &&
          e.kind !== 'source' &&
          e.kind !== 'source_version',
        'INVALID_ACTION_HISTORY',
        '撤销历史的对象版本缺失或范围错误',
        409,
      );
      return e;
    };
    requireThat(
      sameHistoricalState(objects.get(ref.id), read(from)),
      'HISTORY_CONFLICT',
      '相关内容已变化，不能覆盖当前内容。请重新读取后核对历史',
      409,
    );
    const restored = read(to);
    if (restored) next.set(ref.id, restored);
    else next.delete(ref.id);
  }
  assertGraph(next);
  return next;
}

export function beginWorkflowAction(
  repo: ResearchRepository,
  projectId: string,
  workflowId: string,
  actor: Actor,
  now: string,
) {
  const journal = readJournal(repo, projectId);
  journal.entries = [
    ...journal.entries.slice(0, journal.cursor),
    { id: randomUUID(), label: '梳理并查证', at: now, actor, objects: [], workflowId },
  ].slice(-40);
  journal.cursor = journal.entries.length;
  journal.version++;
  saveJournal(repo, projectId, journal);
}
